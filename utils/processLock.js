const fs = require("node:fs/promises");

async function pidExists(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readExistingLock(lockPath) {
  try {
    const raw = await fs.readFile(lockPath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function writeLock(lockPath) {
  const payload = JSON.stringify({
    pid: process.pid,
    createdAt: new Date().toISOString()
  });

  await fs.writeFile(lockPath, payload, {
    flag: "wx"
  });
}

async function acquireProcessLock(lockPath) {
  try {
    await writeLock(lockPath);
    return true;
  } catch (error) {
    if (error.code !== "EEXIST") {
      throw error;
    }
  }

  const existingLock = await readExistingLock(lockPath);
  const existingPid = Number(existingLock?.pid);

  if (await pidExists(existingPid)) {
    return false;
  }

  await fs.unlink(lockPath).catch(() => null);
  await writeLock(lockPath);
  return true;
}

async function releaseProcessLock(lockPath) {
  await fs.unlink(lockPath).catch(() => null);
}

module.exports = {
  acquireProcessLock,
  releaseProcessLock
};
