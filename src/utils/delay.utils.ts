export const delay = (milliseconds: number): Promise<void> =>
    new Promise((resolve) => {
        const timer = setTimeout(resolve, milliseconds);
        timer.unref();
    });
