const User = require('../models/user_model');
const Sponsor = require('../models/sponsor_model');
const puppeteer = require('puppeteer');
const axios = require('axios');
const { Markup } = require('telegraf');

// A map to prevent users from spamming the download command
const cooldownMap = new Map();
const COOLDOWN_MS = 10 * 1000; // 10 seconds

/**
 * Creates or updates a user in the database when they interact with the bot.
 */
const upsertUser = async (userId) => {
    try {
        await User.updateOne(
            { userId },
            { $set: { lastUsed: new Date() }, $setOnInsert: { joinedAt: new Date(), userId } },
            { upsert: true }
        );
    } catch (error) {
        console.error(`Error upserting user ${userId}:`, error);
    }
};

/**
 * The /start command handler. Welcomes the user and registers them.
 */
const startCommand = async (ctx) => {
    await upsertUser(ctx.from.id);
    const welcomeMessage = `
*👋 به ربات ما خوش آمدید!*

این ربات به شما کمک می‌کند تا ویدیوها و تصاویر اینستاگرام را به راحتی دانلود کنید.

کافیست لینک پست، ریل یا IGTV را برای من ارسال کنید.

/help - نمایش راهنما
    `;
    await ctx.replyWithMarkdown(welcomeMessage);
};

/**
 * The /help command handler. Provides instructions.
 */
const helpCommand = async (ctx) => {
    const helpMessage = `
*📚 راهنمای استفاده از ربات*

*📥 دانلود از اینستاگرام:*
کافیست لینک یک پست، ریل (Reel) یا IGTV اینستاگرام را برای من ارسال کنید تا فایل مربوطه را برای شما دانلود کنم.

*⚠️ توجه:* برای استفاده از قابلیت دانلود، باید ابتدا در کانال‌های اسپانسر ما عضو شوید. ربات به صورت خودکار این موضوع را بررسی می‌کند.
    `;
    await ctx.replyWithMarkdown(helpMessage);
};

/**
 * Checks if a user is a member of all sponsor channels.
 * @returns {Promise<{isMember: boolean, buttons: Array}>}
 */
const verifySponsorship = async (ctx) => {
    const sponsors = await Sponsor.find();
    if (sponsors.length === 0) {
        return { isMember: true, buttons: [] }; // No sponsors, access granted
    }

    let allJoined = true;
    for (const sponsor of sponsors) {
        try {
            const member = await ctx.telegram.getChatMember(sponsor.channelId, ctx.from.id);
            if (['left', 'kicked', 'banned'].includes(member.status)) {
                allJoined = false;
                break;
            }
        } catch (error) {
            console.error(`Error checking membership for user ${ctx.from.id} in channel ${sponsor.channelId}:`, error.message);
            allJoined = false; // Assume not joined if bot can't check (e.g., not admin)
            break;
        }
    }

    if (allJoined) {
        return { isMember: true, buttons: [] };
    }

    // If not all joined, prepare the join buttons
    const buttons = sponsors.map(s => [Markup.button.url(`📢 عضویت در کانال ${s.channelTitle}`, s.channelLink)]);
    buttons.push([Markup.button.callback('✅ عضو شدم، بررسی کن', 'check_joined')]);

    return { isMember: false, buttons };
};


/**
 * Middleware to protect the downloader.
 * If user is not a member of sponsor channels, it shows the join message.
 */
const sponsorshipGate = async (ctx, next) => {
    const { isMember, buttons } = await verifySponsorship(ctx);

    if (isMember) {
        return next(); // User is a member, proceed to download
    }

    const joinMessage = '📢 برای استفاده از قابلیت دانلود، لطفاً ابتدا در کانال‌های اسپانسر ما عضو شوید و سپس دکمه "عضو شدم" را بزنید.';
    await ctx.reply(joinMessage, Markup.inlineKeyboard(buttons));
};

/**
 * Handles the 'check_joined' callback button press.
 */
const checkJoinedAction = async (ctx) => {
    await ctx.answerCbQuery('⏳ در حال بررسی عضویت شما...');
    const { isMember, buttons } = await verifySponsorship(ctx);

    if (isMember) {
        await ctx.editMessageText('✅ تایید شد! حالا می‌توانید لینک اینستاگرام خود را ارسال کنید تا دانلود شود.');
    } else {
        await ctx.editMessageText('❌ شما هنوز عضو تمام کانال‌ها نشده‌اید. لطفا دوباره تلاش کنید.', Markup.inlineKeyboard(buttons));
    }
};

/**
 * The main function to handle Instagram link processing and downloading.
 */
const instagramDownloadHandler = async (ctx) => {
    // 1. Cooldown Check
    const now = Date.now();
    const lastUsed = cooldownMap.get(ctx.from.id);
    if (lastUsed && now - lastUsed < COOLDOWN_MS) {
        const remainingSeconds = Math.ceil((COOLDOWN_MS - (now - lastUsed)) / 1000);
        return ctx.reply(`⏳ لطفاً ${remainingSeconds} ثانیه صبر کنید و سپس دوباره امتحان کنید.`);
    }
    cooldownMap.set(ctx.from.id, now);

    // 2. Update user activity
    await upsertUser(ctx.from.id);

    const url = ctx.message.text;
    await ctx.reply('⏳ در حال پردازش لینک شما... لطفاً کمی صبر کنید.');

    let browser;
    try {
        // 3. Launch Puppeteer
        browser = await puppeteer.launch({
            headless: 'new',
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });
        const page = await browser.newPage();

        // Using a generic downloader website
        const targetUrl = `https://snapinsta.app/`;
        await page.goto(targetUrl);
        await page.type('#url', url);
        await page.click('#downloader > div > div > div.col-lg-8.col-md-12.col-12.first > div > form > button');

        // 4. Wait for the download link to appear
        await page.waitForSelector('.download-area .download-btn', { timeout: 30000 });
        const downloadLink = await page.evaluate(() => {
            const button = document.querySelector('.download-area .download-btn');
            return button ? button.href : null;
        });

        if (!downloadLink) {
            throw new Error('لینک دانلود یافت نشد.');
        }

        // 5. Send the file to the user
        const response = await axios({ url: downloadLink, responseType: 'stream' });
        const contentType = response.headers['content-type'];

        if (contentType.startsWith('video')) {
            await ctx.replyWithVideo({ source: response.data }, { caption: '✅ @YourBotName' });
        } else if (contentType.startsWith('image')) {
            await ctx.replyWithPhoto({ source: response.data }, { caption: '✅ @YourBotName' });
        } else {
            await ctx.reply('فایل شما آماده است، اما نوع آن قابل تشخیص نیست. لینک مستقیم:', Markup.inlineKeyboard([
                [Markup.button.url('🔗 دانلود فایل', downloadLink)]
            ]));
        }

    } catch (error) {
        console.error('Error during Instagram download:', error);
        await ctx.reply('❌ متاسفانه دانلود ناموفق بود. ممکن است لینک شما خصوصی باشد یا مشکلی در سرویس دانلود وجود داشته باشد. لطفاً بعداً دوباره تلاش کنید.');
    } finally {
        if (browser) {
            await browser.close();
        }
    }
};


module.exports = (bot) => {
    bot.start(startCommand);
    bot.help(helpCommand);

    // The main listener for Instagram links
    // It first runs the sponsorshipGate middleware. If that passes, it calls the download handler.
    bot.hears(
        /(?:https?:\/\/)?(?:www\.)?instagram\.com\/(p|reel|tv|story|stories)\/([a-zA-Z0-9\-_]+)/,
        sponsorshipGate,
        instagramDownloadHandler
    );

    // Handler for the "I Joined" button
    bot.action('check_joined', checkJoinedAction);
};
