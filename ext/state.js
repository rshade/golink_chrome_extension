export function createStateStore(storage) {
  let tail = Promise.resolve();

  function enqueue(operation) {
    const result = tail.then(operation);
    // Keep a failed operation visible to its caller without stopping the queue.
    tail = result.catch(() => {});
    return result;
  }

  async function readState() {
    return (await storage.get(['tsState'])).tsState;
  }

  return {
    initialize() {
      return enqueue(async () => {
        const current = await storage.get(['tsState', 'hostname', 'golinkHost', 'controlURL']);
        const missing = {};
        if (current.tsState === undefined) missing.tsState = { epoch: 1, values: {} };
        if (current.hostname === undefined) {
          const bytes = globalThis.crypto.getRandomValues(new Uint8Array(3));
          missing.hostname = 'golink-ext-' + Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
        }
        if (current.golinkHost === undefined) missing.golinkHost = 'go';
        if (current.controlURL === undefined) missing.controlURL = 'https://controlplane.tailscale.com';
        if (Object.keys(missing).length) await storage.set(missing);
        return { ...current, ...missing };
      });
    },

    write({ epoch, key, value }) {
      return enqueue(async () => {
        const current = await readState();
        if (epoch !== current.epoch) return { applied: false };
        const values = { ...current.values, [key]: value };
        if (value === null) delete values[key];
        const tsState = { epoch, values };
        await storage.set({ tsState });
        return { applied: true };
      });
    },

    advance({ clear }) {
      return enqueue(async () => {
        const current = await readState();
        const tsState = { epoch: current.epoch + 1, values: clear ? {} : current.values };
        await storage.set({ tsState });
        if (clear) await storage.remove(['linksCache']);
        return tsState;
      });
    },

    snapshot() {
      return enqueue(readState);
    },

    idle() {
      return enqueue(() => {});
    },
  };
}
