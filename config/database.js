const mongoose = require('mongoose');

const connectDatabase = async () => {
  if (!process.env.MONGODB_URI) {
    throw new Error('MONGODB_URI is missing from .env');
  }

  // Force connection with explicit timeouts
  return await mongoose.connect(process.env.MONGODB_URI, {
    serverSelectionTimeoutMS: 10000,
    connectTimeoutMS: 10000,
    family: 4, // Force IPv4 to bypass Windows IPv6 DNS issues
  });
};

module.exports = connectDatabase;