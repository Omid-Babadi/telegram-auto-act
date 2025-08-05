const User = require('../models/user_model');
const Sponsor = require('../models/sponsor_model');
const puppeteer = require('puppeteer');
const axios = require('axios');
const { Markup } = require('telegraf');
const Bottleneck = require('bottleneck'); // Add for rate-limiting

// --- Rate Limiter ---
const limiter = new Bottleneck({
  minTime: 50, // 20 requests per second to respect Telegram API limits
  maxConcurrent: 10,
});

// A map to prevent users from spamming the download command
const cooldownMap = new Map();
const COOLDOWN_MS = 10 * 1000; // 10 seconds

/**
 * Creates or updates a user in the database when they interact with the bot.
 */
const upsertUser = async (userId) => {
  const start = Date.now();
  try {
    await User.updateOne(
      { userId },
      { $set: { lastUsed: new Date() }, $setOnInsert: { joinedAt: new Date(), userId } },
      { upsert: true },
    );
    console.log(`upsertUser took ${Date.now() - start}ms for user ${userId}`);
  } catch (error) {
    console.error(`Error upserting user ${userId}:`, error);
  }
};

/**
 * The /start command handler. Welcomes the user and registers them.
 */
const startCommand = async (ctx) => {
  const start = Date.now();
  await upsertUser(ctx.from.id);
  const welcomeMessage = `
*👋 به ربات ما خوش آمدید!*

این ربات به شما کمک می‌کند تا ویدیوها و تصاویر اینستاگرام را به راحتی دانلود کنید.

کافیست لینک پست، ریل یا IGTV را برای من ارسال کنید.

/help - نمایش راهنما
    `;
  await ctx.replyWithMarkdown(welcomeMessage);
  console.log(`startCommand took ${Date.now() - start}ms for user ${ctx.from.id}`);
};

/**
 * The /help command handler. Provides instructions.
 */
const helpCommand = async (ctx) => {
  const start = Date.now();
  const helpMessage = `
*📚 راهنمای استفاده از ربات*

*📥 دانلود از اینستاگرام:*
کافیست لینک یک پست، ریل (Reel) یا IGTV اینستاگرام را برای من ارسال کنید تا فایل مربوطه را برای شما دانلود کنم.

*⚠️ توجه:* برای استفاده از قابلیت دانلود، باید ابتدا در کانال‌های اسپانسر ما عضو شوید. ربات به صورت خودکار این موضوع را بررسی می‌کند.
    `;
  await ctx.replyWithMarkdown(helpMessage);
  console.log(`helpCommand took ${Date.now() - start}ms for user ${ctx.from.id}`);
};

/**
 * Checks if a user is a member of all sponsor channels.
 * @returns {Promise<{isMember: boolean, buttons: Array}>}
 */
const verifySponsorship = async (ctx) => {
  const start = Date.now();
  try {
    const sponsors = await Sponsor.find();
    if (sponsors.length === 0) {
      console.log(`verifySponsorship took ${Date.now() - start}ms for user ${ctx.from.id} (no sponsors)`);
      return { isMember: true, buttons: [] }; // No sponsors, access granted
    }

    let allJoined = true;
    for (const sponsor of sponsors) {
      try {
        const member = await limiter.schedule(() => ctx.telegram.getChatMember(sponsor.channelId, ctx.from.id));
        if (['left', 'kicked', 'banned'].includes(member.status)) {
          allJoined = false;
          break;
        }
      } catch (error) {
        console.error(`Error checking membership for user ${ctx.from.id} in channel ${sponsor.channelId}:`, error.message);
        allJoined = false; // Assume not joined if bot can't check
        break;
      }
    }

    if (allJoined) {
      console.log(`verifySponsorship took ${Date.now() - start}ms for user ${ctx.from.id} (all joined)`);
      return { isMember: true, buttons: [] };
    }

    // If not all joined, prepare the join buttons
    const buttons = sponsors.map((s) => [Markup.button.url(`📢 عضویت در کانال ${s.channelTitle}`, s.channelLink)]);
    buttons.push([Markup.button.callback('✅ عضو شدم، بررسی کن', 'check_joined')]);

    console.log(`verifySponsorship took ${Date.now() - start}ms for user ${ctx.from.id} (not joined)`);
    return { isMember: false, buttons };
  } catch (error) {
    console.error(`Error in verifySponsorship for user ${ctx.from.id}:`, error);
    return { isMember: false, buttons: [[Markup.button.callback('✅ دوباره بررسی کن', 'check_joined')]] };
  }
};

/**
 * Middleware to protect the downloader.
 * If user is not a member of sponsor channels, it shows the join message.
 */
const sponsorshipGate = async (ctx, next) => {
  const start = Date.now();
  const { isMember, buttons } = await verifySponsorship(ctx);

  if (isMember) {
    console.log(`sponsorshipGate passed in ${Date.now() - start}ms for user ${ctx.from.id}`);
    return next(); // User is a member, proceed to download
  }

  const joinMessage = '📢 برای استفاده از قابلیت دانلود، لطفاً ابتدا در کانال‌های اسپانسر ما عضو شوید و سپس دکمه "عضو شدم" را بزنید.';
  await ctx.reply(joinMessage, Markup.inlineKeyboard(buttons));
  console.log(`sponsorshipGate blocked in ${Date.now() - start}ms for user ${ctx.from.id}`);
};

/**
 * Handles the 'check_joined' callback button press.
 */
const checkJoinedAction = async (ctx) => {
  const start = Date.now();
  await ctx.answerCbQuery('⏳ در حال بررسی عضویت شما...');
  const { isMember, buttons } = await verifySponsorship(ctx);

  if (isMember) {
    await ctx.editMessageText('✅ تایید شد! حالا می‌توانید لینک اینستاگرام خود را ارسال کنید تا دانلود شود.');
  } else {
    await ctx.editMessageText('❌ شما هنوز عضو تمام کانال‌ها نشده‌اید. لطفا دوباره تلاش کنید.', Markup.inlineKeyboard(buttons));
  }
  console.log(`checkJoinedAction took ${Date.now() - start}ms for user ${ctx.from.id}`);
};

/**
 * The main function to handle Instagram link processing and downloading.
 */
const instagramDownloadHandler = async (ctx) => {
  const start = Date.now();
  // 1. Cooldown Check
  const now = Date.now();
  const lastUsed = cooldownMap.get(ctx.from.id);
  if (lastUsed && now - lastUsed < COOLDOWN_MS) {
    const remainingSeconds = Math.ceil((COOLDOWN_MS - (now - lastUsed)) / 1000);
    await ctx.reply(`⏳ لطفاً ${remainingSeconds} ثانیه صبر کنید و سپس دوباره امتحان کنید.`);
    console.log(`instagramDownloadHandler blocked by cooldown in ${Date.now() - start}ms for user ${ctx.from.id}`);
    return;
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
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    const page = await browser.newPage();

    // Using a generic downloader website
    const targetUrl = `https://snapinsta.to/en`;
    await page.goto(targetUrl);
    await page.type('#s_input', url);
    await page.click('button.btn.btn-default');

    // 4. Wait for the download link to appear
    await page.waitForSelector('a.abutton.is-success.is-fullwidth.btn-premium.mt-3', { timeout: 70000 });
    const downloadLink = await page.evaluate(() => {
      const button = document.querySelector('a.abutton.is-success.is-fullwidth.btn-premium.mt-3');
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
        [Markup.button.url('🔗 دانلود فایل', downloadLink)],
      ]));
    }

  } catch (error) {
    console.error(`Error during Instagram download for user ${ctx.from.id}:`, error);
    await ctx.reply('❌ متاسفانه دانلود ناموفق بود. ممکن است لینک شما خصوصی باشد یا مشکلی در سرویس دانلود وجود داشته باشد. لطفاً بعداً دوباره تلاش کنید.');
  } finally {
    if (browser) {
      await browser.close();
    }
    console.log(`instagramDownloadHandler took ${Date.now() - start}ms for user ${ctx.from.id}`);
  }
};

/**
 * Middleware to validate session size (future-proofing)
 */
const sessionValidator = async (ctx, next) => {
  const start = Date.now();
  if (ctx.session && Object.keys(ctx.session).length > 0) {
    const sessionSize = JSON.stringify(ctx.session).length;
    if (sessionSize > 1024) { // 1KB limit
      console.warn(`Session too large for user ${ctx.from.id}: ${sessionSize} bytes`);
      ctx.session = null;
      await ctx.reply('❌ جلسه شما منقضی شد. لطفاً دوباره تلاش کنید.');
      return;
    }
  }
  await next();
  console.log(`sessionValidator took ${Date.now() - start}ms for user ${ctx.from.id}`);
};

module.exports = (bot) => {
  bot.use(sessionValidator); // Add session validation middleware

  bot.start(startCommand);
  bot.help(helpCommand);

  // The main listener for Instagram links
  // It first runs the sponsorshipGate middleware. If that passes, it calls the download handler.
  bot.hears(
    /(?:https?:\/\/)?(?:www\.)?instagram\.com\/(p|reel|tv|story|stories)\/([a-zA-Z0-9\-_]+)/,
    sponsorshipGate,
    instagramDownloadHandler,
  );

  // Handler for the "I Joined" button
  bot.action('check_joined', checkJoinedAction);
};
