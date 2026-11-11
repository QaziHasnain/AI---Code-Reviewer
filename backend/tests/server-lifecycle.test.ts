import { EventEmitter } from 'node:events';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { startServer } from '@/server-lifecycle.js';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeApp() {
  const hooks: Array<() => Promise<unknown>> = [];
  const app = {
    addHook: vi.fn((_name: string, hook: () => Promise<unknown>) => {
      hooks.push(hook);
      return app;
    }),
    listen: vi.fn().mockResolvedValue('http://127.0.0.1:4000'),
    close: vi.fn(async () => {
      await Promise.all(hooks.map((hook) => hook()));
    }),
    log: { error: vi.fn() },
  } as unknown as FastifyInstance;
  return { app, hooks };
}

function options(overrides: Partial<Parameters<typeof startServer>[0]> = {}) {
  const { app } = makeApp();
  return {
    createApp: vi.fn().mockResolvedValue(app),
    disconnectPrisma: vi.fn().mockResolvedValue(undefined),
    listenOptions: { port: 4000, host: '127.0.0.1' },
    signals: new EventEmitter(),
    ...overrides,
  };
}

describe('server lifecycle', () => {
  it('closes the app and disconnects Prisma once on normal graceful shutdown', async () => {
    const config = options();
    const running = await startServer(config);
    await running.shutdown();
    expect(running.app.close).toHaveBeenCalledTimes(1);
    expect(config.disconnectPrisma).toHaveBeenCalledTimes(1);
  });

  it.each(['SIGINT', 'SIGTERM'] as const)('shuts down on %s', async (signal) => {
    const config = options();
    const running = await startServer(config);
    (config.signals as EventEmitter).emit(signal);
    await running.shutdown();
    expect(running.app.close).toHaveBeenCalledTimes(1);
    expect(config.disconnectPrisma).toHaveBeenCalledTimes(1);
  });

  it('coalesces repeated shutdown signals while close is pending', async () => {
    const closeGate = deferred<void>();
    const config = options();
    const { app } = makeApp();
    vi.mocked(app.close).mockReturnValue(closeGate.promise);
    config.createApp.mockResolvedValue(app);
    const running = await startServer(config);

    (config.signals as EventEmitter).emit('SIGINT');
    (config.signals as EventEmitter).emit('SIGTERM');
    const pendingShutdown = running.shutdown();
    await Promise.resolve();
    expect(app.close).toHaveBeenCalledTimes(1);
    expect(config.disconnectPrisma).not.toHaveBeenCalled();

    closeGate.resolve();
    await pendingShutdown;
    expect(config.disconnectPrisma).toHaveBeenCalledTimes(1);
  });

  it('disconnects Prisma when application construction fails', async () => {
    const constructionError = new Error('app construction failed');
    const config = options({ createApp: vi.fn().mockRejectedValue(constructionError) });
    await expect(startServer(config)).rejects.toBe(constructionError);
    expect(config.disconnectPrisma).toHaveBeenCalledTimes(1);
  });

  it('closes the app and disconnects after listen fails', async () => {
    const config = options();
    const { app } = makeApp();
    vi.mocked(app.listen).mockRejectedValue(new Error('listen failed'));
    config.createApp.mockResolvedValue(app);

    await expect(startServer(config)).rejects.toThrow('listen failed');
    expect(app.close).toHaveBeenCalledTimes(1);
    expect(config.disconnectPrisma).toHaveBeenCalledTimes(1);
  });

  it('still disconnects once if app.close fails before running onClose hooks', async () => {
    const config = options();
    const { app } = makeApp();
    vi.mocked(app.close).mockRejectedValue(new Error('close failed'));
    config.createApp.mockResolvedValue(app);
    const running = await startServer(config);

    await expect(running.shutdown()).rejects.toThrow('close failed');
    expect(config.disconnectPrisma).toHaveBeenCalledTimes(1);
  });

  it('does not call Prisma disconnect again after a failed shutdown is retried', async () => {
    const config = options();
    const { app } = makeApp();
    vi.mocked(app.close).mockRejectedValue(new Error('close failed'));
    config.createApp.mockResolvedValue(app);
    const running = await startServer(config);

    await expect(running.shutdown()).rejects.toThrow('close failed');
    await expect(running.shutdown()).rejects.toThrow('close failed');
    expect(config.disconnectPrisma).toHaveBeenCalledTimes(1);
  });
});
