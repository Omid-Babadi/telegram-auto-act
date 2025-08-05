const { Telegraf } = require('telegraf');
const mongoose = require('mongoose');
const { session } = require('telegraf-session-mongodb');
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

// --- Bot Initialization ---
const bot = new Telegraf(config.botToken);

// --- Register Middleware and Handlers ---
// All middleware and handlers must be registered BEFORE the bot is launched.

// Logging middleware
bot.use((ctx, next) => {
    const userId = ctx.from?.id || 'N/A';
    const messageType = ctx.message?.text ? 'text' : ctx.updateType;
    console.log(`[${new Date().toISOString()}] Received ${messageType} from user ${userId}`);
    return next();
});


// --- Database Connection and Launch ---
mongoose.connect(config.mongoURI, {}).then(async () => {
    console.log('✅ Connected to MongoDB');

    const db = mongoose.connection.db;

    // Session middleware first
    bot.use(session(db, {
        collectionName: 'sessions',
        ttl: 900,
        sessionKey: (ctx) => {
            if (ctx.from?.id) return `session:${ctx.from.id}`;
            if (ctx.update?.chat_join_request?.from?.id) return `session:${ctx.update.chat_join_request.from.id}`;
            return `session:unknown_${ctx.update.update_id}`;
        },
    }));

    // Logging middleware after session to show session data
    bot.use((ctx, next) => {
        console.log(`User ${ctx.from?.id}, session:`, ctx.session);
        return next();
    });

    // Register handlers that use sessions
    require('./handlers/user_handler')(bot);
    require('./handlers/admin_handler')(bot);

    bot.launch();
});

// --- Graceful Shutdown ---
process.once('SIGINT', async () => {
    await mongoose.connection.close();
    bot.stop('SIGINT');
});
process.once('SIGTERM', async () => {
    await mongoose.connection.close();
    bot.stop('SIGTERM');
});
