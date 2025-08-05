const { Markup } = require('telegraf');
const config = require('../config');
const Channel = require('../models/channel_model');
const Sponsor = require('../models/sponsor_model');
const User = require('../models/user_model');
const Bottleneck = require('bottleneck');

// --- Rate Limiter ---
const limiter = new Bottleneck({
  minTime: 50, // 20 requests per second to respect Telegram API limits
  maxConcurrent: 10,
});

// --- Middleware ---
const adminOnly = (ctx, next) => {
  console.log(`Admin check for user ${ctx.from?.id}, admins: ${config.admins}`); // Debug admin access
  if (ctx.from && config.admins.includes(ctx.from.id)) return next();
  console.log(`Non-admin user ${ctx.from?.id} tried to use an admin command.`);
};

// --- UI Helpers ---
const getAdminMenu = () => ({
  text: '*⚙️ پنل مدیریت*\n\nاز دکمه‌های زیر برای مدیریت ربات استفاده کنید.',
  keyboard: Markup.inlineKeyboard([
    [Markup.button.callback('📣 کانال‌های من', 'my_channels_menu_0')],
    [Markup.button.callback('⭐ مدیریت اسپانسرها', 'sponsors_menu_0')],
    [Markup.button.callback('📡 ارسال همگانی', 'broadcast_menu')],
    [Markup.button.callback('✖️ بستن', 'close_panel')],
  ]),
});

// --- Admin Menu ---
const adminCommand = async (ctx) => {
  const { text, keyboard } = getAdminMenu();
  await ctx.reply(text, { ...keyboard, parse_mode: 'Markdown' });
};

// --- Channels ---
const getMyChannelsMenu = async (ctx, page = 0) => {
  const start = Date.now();
  const adminId = ctx.from.id;
  const limit = 3;
  const channels = await Channel.find({ ownerId: adminId })
    .sort({ _id: -1 })
    .skip(page * limit)
    .limit(limit);
  const total = await Channel.countDocuments({ ownerId: adminId });

  let text = '*📣 مدیریت کانال‌های من*\n\n' + (channels.length ? 'لیست کانال‌های شما:' : 'شما هیچ کانالی ثبت نکرده‌اید.');
  const buttons = channels.flatMap((ch) => [
    [Markup.button.callback(`- ${ch.channelTitle} -`, `channel_info_${ch.channelId}`)],
    [
      Markup.button.callback(ch.active ? '✅ تایید خودکار: روشن' : '❌ تایید خودکار: خاموش', `channel_toggle_${ch.channelId}`),
      Markup.button.callback('✍️ پیام خوش‌آمد', `channel_welcome_${ch.channelId}`),
    ],
    [Markup.button.callback('🗑 حذف کانال', `channel_delete_${ch.channelId}`)],
  ]);

  const nav = [];
  if (page > 0) nav.push(Markup.button.callback('⬅️ قبلی', `my_channels_menu_${page - 1}`));
  if ((page + 1) * limit < total) nav.push(Markup.button.callback('➡️ بعدی', `my_channels_menu_${page + 1}`));
  if (nav.length) buttons.push(nav);

  buttons.push([Markup.button.callback('➕ افزودن کانال', 'channel_add')], [Markup.button.callback('🔙 بازگشت به پنل', 'admin_panel')]);

  console.log(`getMyChannelsMenu took ${Date.now() - start}ms for user ${ctx.from.id}`);
  return { text, keyboard: Markup.inlineKeyboard(buttons) };
};

const myChannelsCommand = async (ctx) => {
  const { text, keyboard } = await getMyChannelsMenu(ctx);
  await ctx.reply(text, { ...keyboard, parse_mode: 'Markdown' });
};

const addChannelPrompt = async (ctx) => {
  ctx.session = { action: 'await_forwarded_channel' };
  console.log(`Set session for user ${ctx.from.id}:`, ctx.session); // Debug session
  await ctx.editMessageText('لطفاً یک پیام از کانال خود فوروارد کنید.\n\n*توجه:* ربات باید در کانال شما ادمین باشد.');
};

const handleAddChannel = limiter.wrap(async (ctx) => {
  const start = Date.now();
  const fwd = ctx.message?.forward_from_chat;
  if (!fwd || fwd.type !== 'channel') return ctx.reply('❌ این یک پیام فوروارد شده از کانال نیست.');
  try {
    const admins = await limiter.schedule(() => ctx.telegram.getChatAdministrators(fwd.id));
    if (!admins.some((a) => a.user.id === ctx.botInfo.id)) return ctx.reply('❌ ربات باید در کانال ادمین باشد.');
    await Channel.updateOne(
      { channelId: fwd.id },
      {
        ownerId: ctx.from.id,
        channelId: fwd.id,
        channelTitle: fwd.title,
      },
      { upsert: true },
    );
    await ctx.reply(`✅ کانال "${fwd.title}" با موفقیت ثبت شد.`);
  } catch (err) {
    console.error(`Error in handleAddChannel for user ${ctx.from.id}:`, err);
    return ctx.reply('❌ خطایی در ثبت کانال رخ داد.');
  }

  ctx.session = null;
  const { text, keyboard } = await getMyChannelsMenu(ctx);
  await ctx.reply(text, { ...keyboard, parse_mode: 'Markdown' });
  console.log(`handleAddChannel took ${Date.now() - start}ms for user ${ctx.from.id}`);
});

const toggleChannelActive = async (ctx) => {
  const start = Date.now();
  const channelId = parseInt(ctx.match[1]);
  const channel = await Channel.findOne({ channelId, ownerId: ctx.from.id });
  if (!channel) return ctx.answerCbQuery('خطا');

  channel.active = !channel.active;
  await channel.save();
  await ctx.answerCbQuery(`تایید خودکار ${channel.active ? 'فعال' : 'غیرفعال'} شد.`);

  const { text, keyboard } = await getMyChannelsMenu(ctx);
  await ctx.editMessageText(text, { ...keyboard, parse_mode: 'Markdown' });
  console.log(`toggleChannelActive took ${Date.now() - start}ms for user ${ctx.from.id}`);
};

const deleteChannel = async (ctx) => {
  const start = Date.now();
  await Channel.deleteOne({ channelId: parseInt(ctx.match[1]), ownerId: ctx.from.id });
  await ctx.answerCbQuery('✅ کانال حذف شد.');

  const { text, keyboard } = await getMyChannelsMenu(ctx);
  await ctx.editMessageText(text, { ...keyboard, parse_mode: 'Markdown' });
  console.log(`deleteChannel took ${Date.now() - start}ms for user ${ctx.from.id}`);
};

const setWelcomePrompt = async (ctx) => {
  const channelId = parseInt(ctx.match[1]);
  ctx.session = { action: 'await_welcome_message', channelId };
  console.log(`Set session for welcome message, user ${ctx.from.id}, channel ${channelId}:`, ctx.session);
  await ctx.editMessageText('✍️ لطفاً متن کامل پیام خوش‌آمدگویی جدید را ارسال کنید:', { parse_mode: 'Markdown' });
};

const handleSetWelcome = async (ctx) => {
  const start = Date.now();
  console.log(`handleSetWelcome called for user ${ctx.from.id}, session:`, ctx.session);
  const { channelId } = ctx.session;
  if (!channelId) {
    console.error(`No channelId in session for user ${ctx.from.id}`);
    ctx.session = null;
    return ctx.reply('❌ خطا: کانال مشخص نشده است. لطفاً دوباره تلاش کنید.');
  }
  if (!ctx.message.text) {
    console.error(`No text in message for user ${ctx.from.id}`);
    ctx.session = null;
    return ctx.reply('❌ لطفاً یک پیام متنی ارسال کنید.');
  }
  try {
    const channel = await Channel.findOne({ channelId, ownerId: ctx.from.id });
    if (!channel) {
      console.error(`Channel ${channelId} not found for user ${ctx.from.id}`);
      return ctx.reply('❌ خطا: کانال یافت نشد.');
    }
    await Channel.updateOne(
      { channelId, ownerId: ctx.from.id },
      { welcomeMessage: ctx.message.text },
    );
    console.log(`Saved welcome message for channel ${channelId}: ${ctx.message.text}`);
    await ctx.reply('✅ پیام خوش‌آمدگویی کانال با موفقیت ذخیره شد.');
  } catch (err) {
    console.error(`Error in handleSetWelcome for user ${ctx.from.id}, channel ${channelId}:`, err);
    return ctx.reply('❌ خطایی در ذخیره پیام خوش‌آمدگویی رخ داد.');
  } finally {
    ctx.session = null;
    console.log(`Cleared session for user ${ctx.from.id}`);
  }
  const { text, keyboard } = await getMyChannelsMenu(ctx);
  await ctx.reply(text, { ...keyboard, parse_mode: 'Markdown' });
  console.log(`handleSetWelcome took ${Date.now() - start}ms for user ${ctx.from.id}`);
};


// --- Sponsors ---
const getSponsorsMenu = async (page = 0) => {
  const start = Date.now();
  const limit = 5;
  const sponsors = await Sponsor.find().sort({ _id: -1 }).skip(page * limit).limit(limit);
  const total = await Sponsor.countDocuments();

  let text = '*⭐ مدیریت اسپانسرها*\n\n' + (sponsors.length ? '' : 'هیچ اسپانسری ثبت نشده است.');
  const buttons = sponsors.map((s) => [
    Markup.button.url(s.channelTitle, s.channelLink),
    Markup.button.callback('🗑 حذف', `sponsor_delete_${s.channelId}`),
  ]);

  const nav = [];
  if (page > 0) nav.push(Markup.button.callback('⬅️ قبلی', `sponsors_menu_${page - 1}`));
  if ((page + 1) * limit < total) nav.push(Markup.button.callback('➡️ بعدی', `sponsors_menu_${page + 1}`));
  if (nav.length) buttons.push(nav);

  buttons.push([Markup.button.callback('➕ افزودن اسپانسر', 'sponsor_add')], [Markup.button.callback('🔙 بازگشت به پنل', 'admin_panel')]);

  console.log(`getSponsorsMenu took ${Date.now() - start}ms`);
  return { text, keyboard: Markup.inlineKeyboard(buttons) };
};

const addSponsorPrompt = async (ctx) => {
  ctx.session = { action: 'await_sponsor_channel' };
  console.log(`Set session for sponsor add, user ${ctx.from.id}:`, ctx.session); // Debug session
  await ctx.editMessageText('لطفا یوزرنیم کانال عمومی (@channel) یا یک پیام از کانال خصوصی را فوروارد کنید.');
};

const handleAddSponsor = limiter.wrap(async (ctx) => {
  const start = Date.now();
  try {
    const chat = ctx.message.forward_from_chat || (await limiter.schedule(() => ctx.telegram.getChat(ctx.message.text)));
    const channelLink = chat.username ? `https://t.me/${chat.username}` : await limiter.schedule(() => ctx.telegram.exportChatInviteLink(chat.id));
    await Sponsor.updateOne(
      { channelId: chat.id },
      {
        channelId: chat.id,
        channelTitle: chat.title,
        channelLink,
      },
      { upsert: true },
    );
    await ctx.reply(`✅ اسپانسر "${chat.title}" اضافه شد.`);
  } catch (err) {
    console.error(`Error in handleAddSponsor for user ${ctx.from.id}:`, err);
    return ctx.reply('❌ خطایی در افزودن اسپانسر رخ داد.');
  }

  ctx.session = null;
  const { text, keyboard } = await getSponsorsMenu(0);
  await ctx.reply(text, { ...keyboard, parse_mode: 'Markdown' });
  console.log(`handleAddSponsor took ${Date.now() - start}ms for user ${ctx.from.id}`);
});

const deleteSponsor = async (ctx) => {
  const start = Date.now();
  await Sponsor.deleteOne({ channelId: parseInt(ctx.match[1]) });
  await ctx.answerCbQuery('✅ اسپانسر حذف شد.');

  const { text, keyboard } = await getSponsorsMenu(0);
  await ctx.editMessageText(text, { ...keyboard, parse_mode: 'Markdown' });
  console.log(`deleteSponsor took ${Date.now() - start}ms for user ${ctx.from.id}`);
};

// --- Broadcast ---
const broadcastMenu = async (ctx) => {
  await ctx.editMessageText('📡 لطفاً گروه هدف را برای پیام همگانی انتخاب کنید:', {
    ...Markup.inlineKeyboard([
      [Markup.button.callback('همه کاربران', 'broadcast_target_all')],
      [Markup.button.callback('کاربران ۲۴ ساعت گذشته', 'broadcast_target_24h')],
      [Markup.button.callback('کاربران ۴۸ ساعت گذشته', 'broadcast_target_48h')],
      [Markup.button.callback('کاربران یک هفته گذشته', 'broadcast_target_week')],
      [Markup.button.callback('🔙 بازگشت به پنل', 'admin_panel')],
    ]),
  });
};

const setBroadcastTarget = async (ctx) => {
  ctx.session = { action: 'await_broadcast_message', target: ctx.match[1] };
  console.log(`Set session for broadcast, user ${ctx.from.id}:`, ctx.session); // Debug session
  await ctx.editMessageText('✍️ لطفاً پیامی که می‌خواهید ارسال شود را بفرستید.');
};

const handleBroadcast = async (ctx) => {
  const start = Date.now();
  const { target } = ctx.session;
  ctx.session = null;

  const now = new Date();
  let query = {};
  if (target === '24h') query.joinedAt = { $gte: new Date(now - 24 * 60 * 60 * 1000) };
  else if (target === '48h') query.joinedAt = { $gte: new Date(now - 48 * 60 * 60 * 1000) };
  else if (target === 'week') query.joinedAt = { $gte: new Date(now - 7 * 24 * 60 * 60 * 1000) };

  const cursor = User.find(query).cursor();
  let sent = 0,
    failed = 0;
  await ctx.reply(`⏳ در حال ارسال پیام...`);

  const batchSize = 30; // Telegram allows ~30 messages per second
  let batch = [];
  for await (const user of cursor) {
    batch.push(user);
    if (batch.length >= batchSize) {
      await Promise.all(
        batch.map(async (u) => {
          try {
            await limiter.schedule(() => ctx.copyMessage(u.userId));
            sent++;
          } catch {
            failed++;
          }
        }),
      );
      batch = [];
      await new Promise((resolve) => setTimeout(resolve, 1000)); // Respect Telegram rate limits
    }
  }
  // Handle remaining users
  if (batch.length > 0) {
    await Promise.all(
      batch.map(async (u) => {
        try {
          await limiter.schedule(() => ctx.copyMessage(u.userId));
          sent++;
        } catch {
          failed++;
        }
      }),
    );
  }

  await ctx.reply(`✅ ارسال پیام تمام شد.\nموفق: ${sent}\nناموفق: ${failed}`);
  console.log(`handleBroadcast took ${Date.now() - start}ms for ${sent + failed} users`);
};

// --- Export ---
module.exports = (bot) => {
  bot.command('admin', adminOnly, adminCommand);
  bot.command('mychannels', adminOnly, myChannelsCommand);

  bot.action('admin_panel', adminOnly, async (ctx) => {
    const { text, keyboard } = getAdminMenu();
    await ctx.editMessageText(text, { ...keyboard, parse_mode: 'Markdown' });
  });

  bot.action('close_panel', adminOnly, async (ctx) => await ctx.deleteMessage());

  bot.action(/my_channels_menu_(\d+)/, adminOnly, async (ctx) => {
    const { text, keyboard } = await getMyChannelsMenu(ctx, parseInt(ctx.match[1]));
    await ctx.editMessageText(text, { ...keyboard, parse_mode: 'Markdown' });
  });

  bot.action('channel_add', adminOnly, addChannelPrompt);
  bot.action(/channel_toggle_(-?\d+)/, adminOnly, toggleChannelActive);
  bot.action(/channel_delete_(-?\d+)/, adminOnly, deleteChannel);
  bot.action(/channel_welcome_(-?\d+)/, adminOnly, setWelcomePrompt);

  bot.action(/sponsors_menu_(\d+)/, adminOnly, async (ctx) => {
    const { text, keyboard } = await getSponsorsMenu(parseInt(ctx.match[1]));
    await ctx.editMessageText(text, { ...keyboard, parse_mode: 'Markdown' });
  });

  bot.action('sponsor_add', adminOnly, addSponsorPrompt);
  bot.action(/sponsor_delete_(-?\d+)/, adminOnly, deleteSponsor);

  bot.action('broadcast_menu', adminOnly, broadcastMenu);
  bot.action(/broadcast_target_(.+)/, adminOnly, setBroadcastTarget);

  bot.on('message', adminOnly, async (ctx, next) => {
    console.log(`Received message from ${ctx.from.id}, session:`, ctx.session); // Debug message receipt
    if (!ctx.session?.action) {
      console.log(`No session action for user ${ctx.from.id}, passing to next handler`);
      return next();
    }
    const start = Date.now();
    try {
      // Validate session size to prevent MongoDB bloat
      const sessionSize = JSON.stringify(ctx.session).length;
      if (sessionSize > 1024) {
        console.warn(`Session too large for user ${ctx.from.id}: ${sessionSize} bytes`);
        ctx.session = null;
        return ctx.reply('❌ جلسه شما منقضی شد. لطفاً دوباره تلاش کنید.');
      }

      switch (ctx.session.action) {
        case 'await_forwarded_channel':
          return handleAddChannel(ctx);
        case 'await_welcome_message':
          return handleSetWelcome(ctx);
        case 'await_sponsor_channel':
          return handleAddSponsor(ctx);
        case 'await_broadcast_message':
          return handleBroadcast(ctx);
        default:
          console.log(`Unknown session action ${ctx.session.action} for user ${ctx.from.id}`);
          return next();
      }
    } catch (err) {
      console.error(`Error in session handler for user ${ctx.from.id}:`, err);
      ctx.session = null;
      return ctx.reply('❌ خطایی رخ داد. لطفاً دوباره تلاش کنید.');
    } finally {
      console.log(`Session handler took ${Date.now() - start}ms for user ${ctx.from.id}`);
    }
  });
};
