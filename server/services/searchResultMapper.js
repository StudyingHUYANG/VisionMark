function makeSnippet(row, maxLength = 160) {
  const source = String(row.transcript || row.summary || row.title || '').replace(/\s+/g, ' ').trim();
  return source.length > maxLength ? `${source.slice(0, maxLength - 1)}…` : source;
}

function mapSearchResult(row) {
  const distance = Number(row._distance ?? 1);
  return {
    videoId: row.videoId,
    segmentId: row.segmentId,
    start: Number(row.start),
    end: Number(row.end),
    score: Number(Math.max(0, Math.min(1, 1 - distance)).toFixed(6)),
    title: row.title,
    snippet: makeSnippet(row)
  };
}

module.exports = { mapSearchResult, makeSnippet };
