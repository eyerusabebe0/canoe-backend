const mongoose = require('mongoose');

const adminCredentialSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true, trim: true },
  password: { type: String, required: true },
});

module.exports = mongoose.model('AdminCredential', adminCredentialSchema);