require('dotenv').config();

// Helper function to parse admin IDs from a comma-separated string
const parseAdminIds = (adminIdsString) => {
    if (!adminIdsString) {
        return [];
    }
    return adminIdsString.split(',').map(id => parseInt(id.trim(), 10));
};

module.exports = {
    botToken: process.env.BOT_TOKEN,
    mongoURI: process.env.MONGO_URI,
    admins: parseAdminIds(process.env.ADMIN_IDS),
};
