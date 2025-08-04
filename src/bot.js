const { Telegraf } = require('telegraf');
const mongoose = require('mongoose');
const config = require('./config');

// --- Basic Error Handling ---
if (!config.botToken) {
    console.error('❌ BOT_TOKEN is not defined in your .env file. Please add it.');
    process.exit(1);
}
if (!config.mongoURI) {
    console.error('❌ MONGO_URI is not defined in your .env file. Please add it.');
    process.exit(1);
}

// --- Database Connection ---
mongoose.connect(config.mongoURI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
}).then(() => {
    console.log('✅ با موفقیت به پایگاه داده MongoDB متصل شد.'); // "Successfully connected to MongoDB."
}).catch(err => {
    console.error('❌ خطای اتصال به MongoDB:', err); // "MongoDB connection error:"
    process.exit(1);
});

// --- Bot Initialization ---
const bot = new Telegraf(config.botToken);

// --- A simple state for pending user actions ---
// We will use this to wait for user input, e.g., for a welcome message.
// A more robust solution might use a database, but this is fine for now.
const pendingActions = {};
bot.context.pendingActions = pendingActions;


// --- Middleware for logging ---
bot.use((ctx, next) => {
    const userId = ctx.from?.id || 'N/A';
    const messageType = ctx.message?.text ? 'text' : ctx.updateType;
    console.log(`[${new Date().toISOString()}] Received ${messageType} from user ${userId}`);
    return next();
});


// --- Register Handlers (We will create these files next) ---
require('./handlers/user_handler')(bot);
require('./handlers/admin_handler')(bot);


// --- Core Event Handlers ---
const Channel = require('./models/channel_model');

bot.on('chat_join_request', async (ctx) => {
    const { chat, from } = ctx.update.chat_join_request;
    try {
        const channel = await Channel.findOne({ channelId: chat.id, active: true });
        if (channel) {
            await ctx.telegram.approveChatJoinRequest(chat.id, from.id);
            // Send welcome message in a try-catch block as the user might have blocked the bot
            try {
                await ctx.telegram.sendMessage(from.id, channel.welcomeMessage);
            } catch (pmError) {
                console.error(`Failed to send welcome PM to ${from.id} for channel ${chat.id}:`, pmError.message);
            }
            console.log(`✅ Approved user ${from.id} to join channel ${chat.id}`);
        }
    } catch (error) {
        console.error(`Error processing join request for channel ${chat.id}:`, error);
    }
});


// --- Launch Bot ---
bot.launch().then(() => {
    console.log('🤖 ربات با موفقیت راه‌اندازی شد و در حال اجرا است...'); // "Bot launched successfully and is running..."
}).catch(err => {
    console.error('❌ خطای راه‌اندازی ربات:', err); // "Error launching bot:"
});

// --- Graceful Shutdown ---
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
