const mongoose = require('mongoose');

const commentSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  name: { type: String, default: 'Anonymous guest', trim: true },
  text: { type: String, required: true, trim: true },
  rating: { type: Number, default: 0, min: 0, max: 5 },
}, { timestamps: true });

module.exports = mongoose.model('Comment', commentSchema);