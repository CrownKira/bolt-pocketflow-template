type NonIterableObject = Partial<Record<string, unknown>> & {
    [Symbol.iterator]?: never;
};
type Action = string;
type LoggerCallback = (message: string) => void;

// Status code enum - only includes used statuses
enum NodeStatus {
    Pending = 0,
    Running = 1,
    Success = 2,
    Fail = 3,
}

// Node type enum
enum NodeType {
    Base = 'base',
    Node = 'node',
    BatchNode = 'batch',
    ParallelBatchNode = 'parallel_batch',
    Flow = 'flow',
    BatchFlow = 'batch_flow',
    ParallelBatchFlow = 'parallel_batch_flow',
}

class BaseNode<S = unknown, P extends NonIterableObject = NonIterableObject> {
    protected _params: P = {} as P;
    protected _successors: Map<Action, BaseNode> = new Map();

    // New properties for visualization
    protected _status: NodeStatus = NodeStatus.Pending;
    protected _config: Record<string, unknown> = {};
    protected _summary: string = '';
    protected _nodeType: NodeType = NodeType.Base;
    protected _filepath: string = '';

    protected async _exec(prepRes: unknown): Promise<unknown> {
        return await this.exec(prepRes);
    }

    async prep(shared: S): Promise<unknown> {
        return undefined;
    }

    async exec(prepRes: unknown): Promise<unknown> {
        return undefined;
    }

    async post(
        shared: S,
        prepRes: unknown,
        execRes: unknown,
    ): Promise<Action | undefined> {
        return undefined;
    }

    async _run(shared: S): Promise<Action | undefined> {
        try {
            this._status = NodeStatus.Running;
            const p = await this.prep(shared);
            const e = await this._exec(p);
            this._status = NodeStatus.Success;
            return await this.post(shared, p, e);
        } catch (error) {
            this._status = NodeStatus.Fail;
            throw error;
        }
    }

    async run(shared: S): Promise<Action | undefined> {
        if (this._successors.size > 0)
            console.warn("Node won't run successors. Use Flow.");
        return await this._run(shared);
    }

    setParams(params: P): this {
        this._params = params;
        return this;
    }

    next<T extends BaseNode>(node: T): T {
        this.on('default', node);
        return node;
    }

    on(action: Action, node: BaseNode): this {
        if (this._successors.has(action))
            console.warn(`Overwriting successor for action '${action}'`);
        this._successors.set(action, node);
        return this;
    }

    getNextNode(action: Action = 'default'): BaseNode | undefined {
        const nextAction = action || 'default',
            next = this._successors.get(nextAction);
        if (!next && this._successors.size > 0)
            console.warn(
                `Flow ends: '${nextAction}' not found in [${Array.from(
                    this._successors.keys(),
                )}]`,
            );
        return next;
    }

    clone(): this {
        const clonedNode = Object.create(Object.getPrototypeOf(this));
        Object.assign(clonedNode, this);
        clonedNode._params = { ...this._params };
        clonedNode._successors = new Map(this._successors);
        clonedNode._config = { ...this._config };
        return clonedNode;
    }

    // Public method to get all successors for visualization
    getSuccessors(): Map<Action, BaseNode> {
        return new Map(this._successors);
    }

    // Read-only access to status - no public setter
    getStatus(): number {
        return this._status;
    }

    setConfig(config: Record<string, unknown>): this {
        this._config = config;
        return this;
    }

    getConfig(): Record<string, unknown> {
        return this._config;
    }

    setSummary(summary: string): this {
        this._summary = summary;
        return this;
    }

    getSummary(): string {
        return this._summary;
    }

    // Node type getter
    getNodeType(): NodeType {
        return this._nodeType;
    }

    // Filepath setter and getter
    setFilepath(filepath: string): this {
        this._filepath = filepath;
        return this;
    }

    getFilepath(): string {
        return this._filepath;
    }
}

class Node<
    S = unknown,
    P extends NonIterableObject = NonIterableObject,
> extends BaseNode<S, P> {
    maxRetries: number;
    wait: number;
    currentRetry: number = 0;

    constructor(maxRetries: number = 1, wait: number = 0) {
        super();
        this.maxRetries = maxRetries;
        this.wait = wait;
        this._nodeType = NodeType.Node;
    }

    async execFallback(prepRes: unknown, error: Error): Promise<unknown> {
        throw error;
    }

    async _exec(prepRes: unknown): Promise<unknown> {
        for (
            this.currentRetry = 0;
            this.currentRetry < this.maxRetries;
            this.currentRetry++
        ) {
            try {
                return await this.exec(prepRes);
            } catch (e) {
                if (this.currentRetry === this.maxRetries - 1) {
                    this._status = NodeStatus.Fail;
                    return await this.execFallback(prepRes, e as Error);
                }
                if (this.wait > 0)
                    await new Promise((resolve) =>
                        setTimeout(resolve, this.wait * 1000),
                    );
            }
        }
        return undefined;
    }
}

class BatchNode<
    S = unknown,
    P extends NonIterableObject = NonIterableObject,
> extends Node<S, P> {
    constructor(maxRetries: number = 1, wait: number = 0) {
        super(maxRetries, wait);
        this._nodeType = NodeType.BatchNode;
    }

    async _exec(items: unknown[]): Promise<unknown[]> {
        if (!items || !Array.isArray(items)) return [];
        const results = [];
        for (const item of items) results.push(await super._exec(item));
        return results;
    }
}

class ParallelBatchNode<
    S = unknown,
    P extends NonIterableObject = NonIterableObject,
> extends Node<S, P> {
    constructor(maxRetries: number = 1, wait: number = 0) {
        super(maxRetries, wait);
        this._nodeType = NodeType.ParallelBatchNode;
    }

    async _exec(items: unknown[]): Promise<unknown[]> {
        if (!items || !Array.isArray(items)) return [];
        return Promise.all(items.map((item) => super._exec(item)));
    }
}

class Flow<
    S = unknown,
    P extends NonIterableObject = NonIterableObject
> extends BaseNode<S, P> {
    start: BaseNode;
    protected logger: LoggerCallback;

    constructor(start: BaseNode, logger: LoggerCallback = console.log) {
        super();
        this.start = start;
        this.logger = logger;
        this._nodeType = NodeType.Flow;
    }

    protected async _orchestrate(shared: S, params?: P): Promise<void> {
        let current: BaseNode | undefined = this.start.clone();
        const p = params || this._params;
        while (current) {
            current.setParams(p);
            this.logger(`Executing node: ${current.constructor.name}`);
            const action = await current._run(shared);
            this.logger(`Node ${current.constructor.name} completed with action: ${action}`);
            current = current.getNextNode(action);
            current = current?.clone();
        }
    }

    async _run(shared: S): Promise<Action | undefined> {
        try {
            this._status = NodeStatus.Running;
            this.logger(`Starting flow: ${this.constructor.name}`);
            const pr = await this.prep(shared);
            await this._orchestrate(shared);
            this._status = NodeStatus.Success;
            this.logger(`Flow ${this.constructor.name} completed successfully`);
            return await this.post(shared, pr, undefined);
        } catch (error) {
            this._status = NodeStatus.Fail;
            this.logger(`Flow ${this.constructor.name} failed: ${error}`);
            throw error;
        }
    }

    async exec(prepRes: unknown): Promise<unknown> {
        throw new Error("Flow can't exec.");
    }

    setLogger(logger: LoggerCallback): this {
        this.logger = logger;
        return this;
    }
}

class BatchFlow<
    S = unknown,
    P extends NonIterableObject = NonIterableObject,
    NP extends NonIterableObject[] = NonIterableObject[]
> extends Flow<S, P> {
    constructor(start: BaseNode, logger: LoggerCallback = console.log) {
        super(start, logger);
        this._nodeType = NodeType.BatchFlow;
    }

    async _run(shared: S): Promise<Action | undefined> {
        try {
            this._status = NodeStatus.Running;
            this.logger(`Starting batch flow: ${this.constructor.name}`);
            const batchParams = await this.prep(shared);
            for (const bp of batchParams) {
                const mergedParams = { ...this._params, ...bp };
                this.logger(`Processing batch item`);
                await this._orchestrate(shared, mergedParams);
            }
            this._status = NodeStatus.Success;
            this.logger(`Batch flow ${this.constructor.name} completed successfully`);
            return await this.post(shared, batchParams, undefined);
        } catch (error) {
            this._status = NodeStatus.Fail;
            this.logger(`Batch flow ${this.constructor.name} failed: ${error}`);
            throw error;
        }
    }

    async prep(shared: S): Promise<NP> {
        const empty: readonly NonIterableObject[] = [];
        return empty as NP;
    }
}

class ParallelBatchFlow<
    S = unknown,
    P extends NonIterableObject = NonIterableObject,
    NP extends NonIterableObject[] = NonIterableObject[]
> extends BatchFlow<S, P, NP> {
    constructor(start: BaseNode, logger: LoggerCallback = console.log) {
        super(start, logger);
        this._nodeType = NodeType.ParallelBatchFlow;
    }

    async _run(shared: S): Promise<Action | undefined> {
        try {
            this._status = NodeStatus.Running;
            this.logger(`Starting parallel batch flow: ${this.constructor.name}`);
            const batchParams = await this.prep(shared);
            await Promise.all(
                batchParams.map((bp) => {
                    const mergedParams = { ...this._params, ...bp };
                    this.logger(`Processing parallel batch item`);
                    return this._orchestrate(shared, mergedParams);
                })
            );
            this._status = NodeStatus.Success;
            this.logger(`Parallel batch flow ${this.constructor.name} completed successfully`);
            return await this.post(shared, batchParams, undefined);
        } catch (error) {
            this._status = NodeStatus.Fail;
            this.logger(`Parallel batch flow ${this.constructor.name} failed: ${error}`);
            throw error;
        }
    }
}

export {
    BaseNode,
    Node,
    BatchNode,
    ParallelBatchNode,
    Flow,
    BatchFlow,
    ParallelBatchFlow,
    NodeStatus,
    NodeType,
};