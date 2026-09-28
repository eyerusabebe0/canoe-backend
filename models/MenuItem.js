const mongoose = require('mongoose');

const menuItemSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  name: { type: String, required: true, trim: true },
  amharicName: { type: String, default: '', trim: true },
  category: { type: String, required: true, trim: true, index: true },
  price: { type: String, required: true, trim: true },
  description: { type: String, default: '', trim: true },
  order: { type: Number, default: 0 },
}, { timestamps: true });

module.exports = mongoose.model('MenuItem', menuItemSchema);