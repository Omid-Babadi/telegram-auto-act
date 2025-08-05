const { Markup } = require('telegraf');
const config = require('../config');
const Channel = require('../models/channel_model');
const Sponsor = require('../models/sponsor_model');
const User = require('../models/user_model');

// --- Middleware ---
const adminOnly = (ctx, next) => {
    if (ctx.from && config.admins.includes(ctx.from.id)) {
        return next();
    }
    console.log(`Non-admin user ${ctx.from.id} tried to use an admin command.`);
};

// --- Helper: Main Admin Panel ---
const getAdminMenu = (ctx) => {
    const text = '*⚙️ پنل مدیریت*\n\nاز دکمه‌های زیر برای مدیریت ربات استفاده کنید.';
    const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('📣 کانال‌های من', 'my_channels_menu_0')],
        [Markup.button.callback('⭐ مدیریت اسپانسرها', 'sponsors_menu_0')],
        [Markup.button.callback('📡 ارسال همگانی', 'broadcast_menu')],
        [Markup.button.callback('✖️ بستن', 'close_panel')]
    ]);
    return { text, keyboard };
};

const adminCommand = async (ctx) => {
    const { text, keyboard } = getAdminMenu(ctx);
    await ctx.reply(text, { ...keyboard, parse_mode: 'Markdown' });
};

// --- My Channels Management ---
const getMyChannelsMenu = async (ctx, page = 0) => {
    const channelsPerPage = 3;
    const adminId = ctx.from.id;
    const channels = await Channel.find({ ownerId: adminId }).sort({ _id: -1 }).skip(page * channelsPerPage).limit(channelsPerPage);
    const totalChannels = await Channel.countDocuments({ ownerId: adminId });

    let text = '*📣 مدیریت کانال‌های من*\n\n' + (channels.length === 0 ? 'شما هیچ کانالی ثبت نکرده‌اید.' : 'لیست کانال‌های شما:');
    const buttons = [];
    channels.forEach(ch => {
        // Use callback button instead of text button
        buttons.push([Markup.button.callback(`- ${ch.channelTitle} -`, `channel_info_${ch.channelId}`)]); // Dummy callback_data
        buttons.push([
            Markup.button.callback(ch.active ? '✅ تایید خودکار: روشن' : '❌ تایید خودکار: خاموش', `channel_toggle_${ch.channelId}`),
            Markup.button.callback('✍️ پیام خوش‌آمد', `channel_welcome_${ch.channelId}`),
        ]);
        buttons.push([Markup.button.callback('🗑 حذف کانال', `channel_delete_${ch.channelId}`)]);
    });

    const paginationButtons = [];
    if (page > 0) paginationButtons.push(Markup.button.callback('⬅️ قبلی', `my_channels_menu_${page - 1}`));
    if ((page + 1) * channelsPerPage < totalChannels) paginationButtons.push(Markup.button.callback('➡️ بعدی', `my_channels_menu_${page + 1}`));
    if (paginationButtons.length > 0) buttons.push(paginationButtons);

    buttons.push([Markup.button.callback('➕ افزودن کانال', 'channel_add')]);
    buttons.push([Markup.button.callback('🔙 بازگشت به پنل', 'admin_panel')]);
    return { text, keyboard: Markup.inlineKeyboard(buttons) };
};

const myChannelsCommand = async (ctx) => {
    const { text, keyboard } = await getMyChannelsMenu(ctx, 0);
    await ctx.reply(text, { ...keyboard, parse_mode: 'Markdown' });
};

const addChannelPrompt = async (ctx) => {
    ctx.pendingActions[ctx.from.id] = { action: 'await_forwarded_channel' };
    await ctx.editMessageText('لطفاً برای ثبت کانال، یک پیام از آن فوروارد کنید.\n\n*توجه:* ربات باید در کانال شما ادمین باشد.');
};

const handleAddChannel = async (ctx) => {
    const fwd = ctx.message.forward_from_chat;
    if (!fwd || fwd.type !== 'channel') return ctx.reply('❌ این یک پیام فوروارد شده از کانال نیست.');
    try {
        const admins = await ctx.telegram.getChatAdministrators(fwd.id);
        if (!admins.some(a => a.user.id === ctx.botInfo.id)) return ctx.reply('❌ ربات باید در کانال شما ادمین باشد.');
        await Channel.updateOne({ channelId: fwd.id }, { ownerId: ctx.from.id, channelId: fwd.id, channelTitle: fwd.title }, { upsert: true });
        await ctx.reply(`✅ کانال "${fwd.title}" با موفقیت ثبت شد.`);
    } catch (e) { return ctx.reply('❌ خطایی در ثبت کانال رخ داد.'); }
    delete ctx.pendingActions[ctx.from.id];
    const { text, keyboard } = await getMyChannelsMenu(ctx, 0);
    await ctx.reply(text, { ...keyboard, parse_mode: 'Markdown' });
};

const toggleChannelActive = async (ctx) => {
    const channelId = parseInt(ctx.match[1]);
    const channel = await Channel.findOne({ channelId, ownerId: ctx.from.id });
    if (!channel) return ctx.answerCbQuery('!خطا');
    channel.active = !channel.active;
    await channel.save();
    await ctx.answerCbQuery(`تایید خودکار ${channel.active ? 'فعال' : 'غیرفعال'} شد.`);
    const { text, keyboard } = await getMyChannelsMenu(ctx, 0);
    await ctx.editMessageText(text, { ...keyboard, parse_mode: 'Markdown' });
};

const deleteChannel = async (ctx) => {
    const channelId = parseInt(ctx.match[1]);
    await Channel.deleteOne({ channelId, ownerId: ctx.from.id });
    await ctx.answerCbQuery('✅ کانال حذف شد.');
    const { text, keyboard } = await getMyChannelsMenu(ctx, 0);
    await ctx.editMessageText(text, { ...keyboard, parse_mode: 'Markdown' });
};

const setWelcomePrompt = async (ctx) => {
    const channelId = parseInt(ctx.match[1]);
    ctx.pendingActions[ctx.from.id] = { action: 'await_welcome_message', channelId };
    await ctx.editMessageText('✍️ لطفاً متن کامل پیام خوش‌آمدگویی جدید خود را ارسال کنید:');
};

const handleSetWelcome = async (ctx) => {
    const { channelId } = ctx.pendingActions[ctx.from.id];
    await Channel.updateOne({ channelId, ownerId: ctx.from.id }, { welcomeMessage: ctx.message.text });
    await ctx.reply(`✅ پیام خوش‌آمدگویی کانال با موفقیت به‌روزرسانی شد.`);
    delete ctx.pendingActions[ctx.from.id];
    const { text, keyboard } = await getMyChannelsMenu(ctx, 0);
    await ctx.reply(text, { ...keyboard, parse_mode: 'Markdown' });
};

// --- Sponsor Management --- (Identical to previous step, omitted for brevity)
const getSponsorsMenu = async (page = 0) => {
    const sponsorsPerPage = 5;
    const sponsors = await Sponsor.find().sort({ _id: -1 }).skip(page * sponsorsPerPage).limit(sponsorsPerPage);
    const totalSponsors = await Sponsor.countDocuments();
    let text = '*⭐ مدیریت اسپانسرها*\n\n' + (sponsors.length === 0 ? 'هیچ اسپانسری ثبت نشده است.' : '');
    const buttons = sponsors.map(s => [Markup.button.url(s.channelTitle, s.channelLink), Markup.button.callback(`🗑 حذف`, `sponsor_delete_${s.channelId}`)]);
    const paginationButtons = [];
    if (page > 0) paginationButtons.push(Markup.button.callback('⬅️ قبلی', `sponsors_menu_${page - 1}`));
    if ((page + 1) * sponsorsPerPage < totalSponsors) paginationButtons.push(Markup.button.callback('➡️ بعدی', `sponsors_menu_${page + 1}`));
    if (paginationButtons.length > 0) buttons.push(paginationButtons);
    buttons.push([Markup.button.callback('➕ افزودن اسپانسر', 'sponsor_add')]);
    buttons.push([Markup.button.callback('🔙 بازگشت به پنل', 'admin_panel')]);
    return { text, keyboard: Markup.inlineKeyboard(buttons) };
};
const addSponsorPrompt = async (ctx) => {
    ctx.pendingActions[ctx.from.id] = { action: 'await_sponsor_channel' };
    await ctx.editMessageText('لطفا یوزرنیم کانال عمومی (مثال: @channel) یا آیدی کانال خصوصی را ارسال کنید.\n\n' + 'همچنین می‌توانید یک پیام از کانال خصوصی مورد نظر فوروارد کنید.');
};
const handleAddSponsor = async (ctx) => {
    let chat;
    try {
        if (ctx.message.forward_from_chat) chat = ctx.message.forward_from_chat;
        else if (ctx.message.text) chat = await ctx.telegram.getChat(ctx.message.text);
        else return ctx.reply('❌ ورودی نامعتبر است.');
        const newSponsor = { channelId: chat.id, channelTitle: chat.title, channelLink: chat.username ? `https://t.me/${chat.username}` : (await ctx.telegram.exportChatInviteLink(chat.id)) };
        await Sponsor.updateOne({ channelId: chat.id }, newSponsor, { upsert: true });
        await ctx.reply(`✅ اسپانسر "${chat.title}" با موفقیت افزوده شد.`);
    } catch (e) { return ctx.reply('❌ خطایی در افزودن اسپانسر رخ داد.'); }
    delete ctx.pendingActions[ctx.from.id];
    const { text, keyboard } = await getSponsorsMenu(0);
    await ctx.reply(text, { ...keyboard, parse_mode: 'Markdown' });
};
const deleteSponsor = async (ctx) => {
    await Sponsor.deleteOne({ channelId: parseInt(ctx.match[1]) });
    await ctx.answerCbQuery('✅ اسپانسر با موفقیت حذف شد.');
    const { text, keyboard } = await getSponsorsMenu(0);
    await ctx.editMessageText(text, { ...keyboard, parse_mode: 'Markdown' });
};

// --- Broadcast Management ---
const broadcastMenu = async (ctx) => {
    const text = '📡 لطفاً گروه هدف برای ارسال پیام همگانی را انتخاب کنید:';
    const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('همه کاربران', 'broadcast_target_all')],
        [Markup.button.callback('کاربران ۲۴ ساعت گذشته', 'broadcast_target_24h')],
        [Markup.button.callback('کاربران ۴۸ ساعت گذشته', 'broadcast_target_48h')],
        [Markup.button.callback('کاربران یک هفته گذشته', 'broadcast_target_week')],
        [Markup.button.callback('🔙 بازگشت به پنل', 'admin_panel')],
    ]);
    await ctx.editMessageText(text, { ...keyboard });
};

const setBroadcastTarget = async (ctx) => {
    const target = ctx.match[1];
    ctx.pendingActions[ctx.from.id] = { action: 'await_broadcast_message', target };
    await ctx.editMessageText('✍️ لطفاً پیامی که می‌خواهید پخش کنید را ارسال نمایید.');
};

const handleBroadcast = async (ctx) => {
    const { target } = ctx.pendingActions[ctx.from.id];
    delete ctx.pendingActions[ctx.from.id];

    let query = {};
    const now = new Date();
    if (target === '24h') query.joinedAt = { $gte: new Date(now - 24 * 60 * 60 * 1000) };
    else if (target === '48h') query.joinedAt = { $gte: new Date(now - 48 * 60 * 60 * 1000) };
    else if (target === 'week') query.joinedAt = { $gte: new Date(now - 7 * 24 * 60 * 60 * 1000) };

    const users = await User.find(query).lean();
    await ctx.reply(`⏳ در حال ارسال پیام به ${users.length} کاربر...`);

    let sentCount = 0, failedCount = 0;
    for (const user of users) {
        try {
            await ctx.copyMessage(user.userId);
            sentCount++;
        } catch (e) {
            failedCount++;
        }
    }
    await ctx.reply(`✅ پیام همگانی ارسال شد.\n\nموفق: ${sentCount}\nناموفق: ${failedCount}`);
};

module.exports = (bot) => {
    // Commands
    bot.command('admin', adminOnly, adminCommand);
    bot.command('mychannels', adminOnly, myChannelsCommand);
    // Panel Navigation
    bot.action('admin_panel', adminOnly, async (ctx) => { const { text, keyboard } = getAdminMenu(ctx); await ctx.editMessageText(text, { ...keyboard, parse_mode: 'Markdown' }); });
    bot.action('close_panel', adminOnly, async (ctx) => { await ctx.deleteMessage(); });
    // My Channels
    bot.action(/my_channels_menu_(\d+)/, adminOnly, async (ctx) => { const { text, keyboard } = await getMyChannelsMenu(ctx, parseInt(ctx.match[1])); await ctx.editMessageText(text, { ...keyboard, parse_mode: 'Markdown' }); });
    bot.action('channel_add', adminOnly, addChannelPrompt);
    bot.action(/channel_toggle_(-?\d+)/, adminOnly, toggleChannelActive);
    bot.action(/channel_delete_(-?\d+)/, adminOnly, deleteChannel);
    bot.action(/channel_welcome_(-?\d+)/, adminOnly, setWelcomePrompt);
    // Sponsors
    bot.action(/sponsors_menu_(\d+)/, adminOnly, async (ctx) => { const { text, keyboard } = await getSponsorsMenu(parseInt(ctx.match[1])); await ctx.editMessageText(text, { ...keyboard, parse_mode: 'Markdown' }); });
    bot.action('sponsor_add', adminOnly, addSponsorPrompt);
    bot.action(/sponsor_delete_(-?\d+)/, adminOnly, deleteSponsor);
    // Broadcast
    bot.action('broadcast_menu', adminOnly, broadcastMenu);
    bot.action(/broadcast_target_(.+)/, adminOnly, setBroadcastTarget);
    // Message Handler for pending actions
    bot.on('message', adminOnly, async (ctx, next) => {
        if (!ctx.from || !ctx.pendingActions[ctx.from.id]) return next();
        const pending = ctx.pendingActions[ctx.from.id];
        if (pending.action === 'await_sponsor_channel') return handleAddSponsor(ctx);
        if (pending.action === 'await_forwarded_channel') return handleAddChannel(ctx);
        if (pending.action === 'await_welcome_message') return handleSetWelcome(ctx);
        if (pending.action === 'await_broadcast_message') return handleBroadcast(ctx);
        return next();
    });
};
