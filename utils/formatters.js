function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) {
    return "Live";
  }

  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }

  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function truncate(text, maxLength = 60) {
  if (!text) {
    return "Unknown";
  }

  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}...` : text;
}

function escapeMarkdown(text) {
  return String(text).replace(/([\\`*_{}[\]()#+\-.!|>~])/g, "\\$1");
}

function parseArgs(content) {
  const matches = content.match(/"([^"]+)"|'([^']+)'|`([^`]+)`|(\S+)/g) || [];
  return matches.map((match) => match.replace(/^["'`]|["'`]$/g, ""));
}

function shuffleArray(array) {
  for (let index = array.length - 1; index > 0; index -= 1) {
    const randomIndex = Math.floor(Math.random() * (index + 1));
    [array[index], array[randomIndex]] = [array[randomIndex], array[index]];
  }

  return array;
}

function formatTrackLine(track, index) {
  const requester = track.requester?.tag || "Unknown";
  const title = escapeMarkdown(truncate(track.info.title, 55));
  const uri = track.info.uri || "https://youtube.com";
  return `\`${String(index).padStart(2, "0")}.\` [${title}](${uri}) - ${formatDuration(track.info.length)} - ${escapeMarkdown(requester)}`;
}

module.exports = {
  escapeMarkdown,
  formatDuration,
  formatTrackLine,
  parseArgs,
  shuffleArray,
  truncate
};
