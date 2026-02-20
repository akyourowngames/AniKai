const demoProvider = require('./demo');
const consumetProvider = require('./consumet');
const aniembedProvider = require('./aniembed');
const seanimeProvider = require('./seanime');

const providers = new Map([
  [seanimeProvider.id, seanimeProvider],
  [aniembedProvider.id, aniembedProvider],
  [consumetProvider.id, consumetProvider],
  [demoProvider.id, demoProvider]
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
