const DEMO_STREAMS = [
  'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8',
  'https://test-streams.mux.dev/test_001/stream.m3u8',
  'https://test-streams.mux.dev/dai-discontinuity-deltatre/manifest.m3u8'
];

function getEpisodeList(anime) {
  const total = Math.max(1, Math.min(24, Number(anime.episodeCount) || 1));
  return Array.from({ length: total }, (_, idx) => ({
    number: idx + 1,
    title: `Episode ${idx + 1}`
  }));
}

function getEpisodeSources(anime, episodeNumber) {
  const streamIndex = (Math.max(1, episodeNumber) - 1) % DEMO_STREAMS.length;
  const streamUrl = DEMO_STREAMS[streamIndex];

  const sources = [
    {
      server: 'demo-hls',
      url: streamUrl,
      label: 'Demo HLS',
      quality: 'auto',
      type: 'm3u8'
    }
  ];

  if (anime.trailer?.site === 'youtube' && anime.trailer?.id) {
    sources.unshift({
      server: 'youtube-trailer',
      url: anime.trailer.id,
      label: 'Official Trailer',
      quality: 'auto',
      type: 'youtube'
    });
  }

  return {
    number: episodeNumber,
    videoSources: sources
  };
}

module.exports = {
  id: 'demo',
  name: 'Demo Provider',
  async getEpisodeList({ anime }) {
    return getEpisodeList(anime);
  },
  async getEpisodeSources({ anime, episodeNumber }) {
    return getEpisodeSources(anime, episodeNumber);
  }
};
