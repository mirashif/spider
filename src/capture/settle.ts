import type { Page } from 'playwright';

/** Give requested assets time to finish without waiting forever for lazy images or stalled fonts. */
export async function settle(page: Page, timeoutMs = 5000): Promise<void> {
    await page.evaluate(async (timeoutMs) => {
        const cleanup: (() => void)[] = [];
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            await Promise.race([
                new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
                (async () => {
                    await Promise.all([
                        document.fonts.ready,
                        ...[...document.images].filter((img) => !img.complete && img.loading !== 'lazy').map((img) =>
                            new Promise<void>((resolve) => {
                                const done = resolve as () => void;
                                img.addEventListener('load', done, { once: true });
                                img.addEventListener('error', done, { once: true });
                                cleanup.push(() => {
                                    img.removeEventListener('load', done);
                                    img.removeEventListener('error', done);
                                });
                                if (img.complete) resolve();
                            }),
                        ),
                    ]);
                    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
                })(),
            ]);
        } finally {
            clearTimeout(timer);
            cleanup.forEach((fn) => fn());
        }
    }, timeoutMs);
}
