const mongoose = require('mongoose');
const dns = require('dns');

const configureDns = () => {
  const configuredServers = String(process.env.MONGODB_DNS_SERVERS || '')
    .split(',')
    .map((server) => server.trim())
    .filter(Boolean);

  if (configuredServers.length) {
    dns.setServers(configuredServers);
    return;
  }

  const currentServers = dns.getServers();
  if (currentServers.length && currentServers.every((server) => server === '127.0.0.1' || server === '::1')) {
    dns.setServers(['1.1.1.1', '8.8.8.8']);
  }
};

const connectDatabase = async () => {
  if (!process.env.MONGODB_URI) {
    throw new Error('MONGODB_URI is missing from .env');
  }

  configureDns();

  // Force connection with explicit timeouts
  return await mongoose.connect(process.env.MONGODB_URI, {
    serverSelectionTimeoutMS: 10000,
    connectTimeoutMS: 10000,
    family: 4, // Force IPv4 to bypass Windows IPv6 DNS issues
  });
};

module.exports = connectDatabase;