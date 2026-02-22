const seanimeProvider = require('./seanime');
const animesaturnProvider = require('./animesaturn');
const anicrushProvider = require('./anicrush');
const hianimeProvider = require('./hianime');
const sudatchiProvider = require('./sudatchi');
const anizoneProvider = require('./anizone');
const uniquestreamProvider = require('./uniquestream');
const consumetProvider = require('./consumet');

const providers = new Map([
  [seanimeProvider.id, seanimeProvider],
  [anicrushProvider.id, anicrushProvider],
  [animesaturnProvider.id, animesaturnProvider],
  [hianimeProvider.id, hianimeProvider],
  [sudatchiProvider.id, sudatchiProvider],
  [anizoneProvider.id, anizoneProvider],
  [uniquestreamProvider.id, uniquestreamProvider],
  [consumetProvider.id, consumetProvider]   // NEW: CF-resilient via @consumet/extensions
]);

function listProviders() {
  return Array.from(providers.values()).map((provider) => ({
    id: provider.id,
    name: provider.name
  }));
}

function getProvider(providerId) {
  if (!providerId) {
    return seanimeProvider;
  }

  return providers.get(providerId) || seanimeProvider;
}

module.exports = {
  listProviders,
  getProvider
};
