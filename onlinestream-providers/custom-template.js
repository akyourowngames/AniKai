// Template provider for your own licensed source.
// Replace the methods with your real authorized API/file source logic.
module.exports = {
  id: 'custom',
  name: 'Custom Licensed Provider',
  async getEpisodeList() {
    return [];
  },
  async getEpisodeSources() {
    return {
      number: 1,
      videoSources: []
    };
  }
};
