const mongoose = require('mongoose');

const channelSchema = new mongoose.Schema({
    ownerId: {
        type: Number,
        required: true,
        index: true // To quickly find all channels for a specific admin
    },
    channelId: {
        type: Number,
        required: true,
        unique: true // Each channel can only be registered once
    },
    channelTitle: {
        type: String,
        required: true
    },
    active: {
        type: Boolean,
        default: true // Auto-join is active by default when a channel is added
    },
    welcomeMessage: {
        type: String,
        default: '🎉 خوش آمدید!' // A friendly default welcome message
    },
});

const Channel = mongoose.model('Channel', channelSchema);

module.exports = Channel;
