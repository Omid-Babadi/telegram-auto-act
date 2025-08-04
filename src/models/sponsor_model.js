const mongoose = require('mongoose');

const sponsorSchema = new mongoose.Schema({
    channelId: {
        type: Number,
        required: true,
        unique: true
    },
    channelTitle: {
        type: String,
        required: true
    },
    // Storing the username or invite link can be very helpful
    channelLink: {
        type: String,
        required: true
    },
});

const Sponsor = mongoose.model('Sponsor', sponsorSchema);

module.exports = Sponsor;
