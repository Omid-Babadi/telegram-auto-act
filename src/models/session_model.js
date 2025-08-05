const mongoose = require('mongoose');

// Define session schema with TTL
const sessionSchema = new mongoose.Schema({
  key: { type: String, required: true },
  data: { type: Object, required: true },
  updatedAt: { type: Date, default: Date.now, expires: 900 }, // Expire after 15 minutes
});


const Session = mongoose.model('Session', sessionSchema);

module.exports = Session;
