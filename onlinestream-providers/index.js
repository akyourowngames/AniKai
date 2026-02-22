const seanimeProvider = require('./seanime');
const anicrushProvider = require('./anicrush');
const hianimeProvider = require('./hianime');
const uniquestreamProvider = require('./uniquestream');
const consumetProvider = require('./consumet');

function createConsumetAliasProvider(id, name, seaProvider) {
  return {
    id,
    name,
    async getEpisodeList(input = {}) {
      return consumetProvider.getEpisodeList({
        ...input,
        seaProvider
      });
    },
    async getEpisodeSources(input = {}) {
      return consumetProvider.getEpisodeSources({
        ...input,
        seaProvider
      });
    }
  };
}

const consumetHiAnimeProvider = createConsumetAliasProvider(
  'consumet-hianime',
  'Consumet HiAnime',
  'hianime'
);
const consumetAnimeKaiProvider = createConsumetAliasProvider(
  'consumet-animekai',
  'Consumet AnimeKai',
  'animekai'
);
const consumetAnimePaheProvider = createConsumetAliasProvider(
  'consumet-animepahe',
  'Consumet AnimePahe',
  'animepahe'
);

const providers = new Map([
  [seanimeProvider.id, seanimeProvider],
  [anicrushProvider.id, anicrushProvider],
  [hianimeProvider.id, hianimeProvider],
  [uniquestreamProvider.id, uniquestreamProvider],
  [consumetProvider.id, consumetProvider],
  [consumetHiAnimeProvider.id, consumetHiAnimeProvider],
  [consumetAnimeKaiProvider.id, consumetAnimeKaiProvider],
  [consumetAnimePaheProvider.id, consumetAnimePaheProvider]
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
