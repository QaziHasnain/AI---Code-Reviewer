import type { FastifyInstance } from 'fastify';

type ShutdownSignal = 'SIGINT' | 'SIGTERM';

interface SignalSource {
  on(signal: ShutdownSignal, listener: () => void): unknown;
}

export interface StartServerOptions {
  createApp: () => Promise<FastifyInstance>;
  disconnectPrisma: () => Promise<unknown>;
  listenOptions: { port: number; host: string };
  signals?: SignalSource;
  onShutdownError?: (error: unknown) => void;
}

export interface RunningServer {
  app: FastifyInstance;
  shutdown(): Promise<void>;
}

export async function startServer(options: StartServerOptions): Promise<RunningServer> {
  let app: FastifyInstance | undefined;
  let disconnectPromise: Promise<void> | undefined;
  let shutdownPromise: Promise<void> | undefined;

  const disconnectOnce = (): Promise<void> => {
    disconnectPromise ??= Promise.resolve().then(async () => {
      await options.disconnectPrisma();
    });
    return disconnectPromise;
  };

  const shutdown = (): Promise<void> => {
    shutdownPromise ??= (async () => {
      let closeError: unknown;
      if (app) {
        try {
          await app.close();
        } catch (error) {
          closeError = error;
        }
      }

      try {
        await disconnectOnce();
      } catch (error) {
        closeError ??= error;
      }

      if (closeError !== undefined) {
        throw closeError;
      }
    })();
    return shutdownPromise;
  };

  const signals = options.signals ?? process;
  const handleShutdownSignal = (): void => {
    void shutdown().catch((error: unknown) => {
      if (options.onShutdownError) {
        options.onShutdownError(error);
      } else {
        console.error('Graceful shutdown failed', error);
        process.exitCode = 1;
      }
    });
  };

  try {
    app = await options.createApp();
    app.addHook('onClose', disconnectOnce);
    signals.on('SIGINT', handleShutdownSignal);
    signals.on('SIGTERM', handleShutdownSignal);
    await app.listen(options.listenOptions);
    return { app, shutdown };
  } catch (startupError) {
    try {
      await shutdown();
    } catch {
      // Preserve the startup error; the shared disconnect operation was still attempted.
    }
    throw startupError;
  }
}
