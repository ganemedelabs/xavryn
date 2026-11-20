interface SvgResult {
    svg: string;
    durationMs: number;
}

interface WorkerResponse extends Partial<SvgResult> {
    id: number;
    error?: string;
}

interface PendingJob {
    resolve: (v: SvgResult) => void;
    reject: (e: Error) => void;
    worker: Worker;
}

interface QueuedJob {
    imageData: ImageData;
    options: Record<string, number>;
    resolve: PendingJob["resolve"];
    reject: PendingJob["reject"];
}

export class WorkerPool {
    private workers: Worker[] = [];
    private idle: Worker[] = [];
    private queue: QueuedJob[] = [];
    private pending = new Map<number, PendingJob>();
    private nextId = 0;
    private terminated = false;

    constructor(size = Math.max(1, Math.min((navigator.hardwareConcurrency || 2) - 1, 8))) {
        for (let i = 0; i < size; i++) {
            const w = new Worker(new URL("../workers/svg.worker.ts", import.meta.url));

            w.onmessage = (e: MessageEvent<WorkerResponse>) => {
                const { id, error, svg, durationMs } = e.data;
                const job = this.pending.get(id);
                this.pending.delete(id);
                this.release(w);

                if (!job) return;
                if (error !== undefined || svg === undefined) {
                    job.reject(new Error(error ?? "Worker returned no SVG"));
                } else {
                    job.resolve({ svg, durationMs: durationMs ?? 0 });
                }
            };

            w.onerror = (e: ErrorEvent) => {
                for (const [id, job] of this.pending) {
                    if (job.worker === w) {
                        this.pending.delete(id);
                        job.reject(new Error(e.message || "Worker crashed"));
                    }
                }
                this.release(w);
            };

            this.workers.push(w);
            this.idle.push(w);
        }
    }

    run(imageData: ImageData, options: Record<string, number>): Promise<SvgResult> {
        return new Promise<SvgResult>((resolve, reject) => {
            if (this.terminated) {
                reject(new Error("WorkerPool terminated"));
                return;
            }
            const job: QueuedJob = { imageData, options, resolve, reject };
            const w = this.idle.pop();
            if (w) {
                this.dispatch(w, job);
            } else {
                this.queue.push(job);
            }
        });
    }

    terminate() {
        this.terminated = true;
        const err = new Error("WorkerPool terminated");
        for (const job of this.queue) job.reject(err);
        for (const job of this.pending.values()) job.reject(err);
        this.queue = [];
        this.pending.clear();
        this.workers.forEach((w) => w.terminate());
        this.workers = [];
        this.idle = [];
    }

    private dispatch(w: Worker, job: QueuedJob) {
        const id = this.nextId++;
        this.pending.set(id, { resolve: job.resolve, reject: job.reject, worker: w });
        w.postMessage({ id, imageData: job.imageData, options: job.options });
    }

    private release(w: Worker) {
        if (this.terminated) return;
        const next = this.queue.shift();
        if (next) {
            this.dispatch(w, next);
        } else {
            this.idle.push(w);
        }
    }
}
