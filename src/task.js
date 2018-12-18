// @flow
const {EventEmitter} = require("events");

type TaskAction<T> = (input: any, task: T) => Promise<any>;

type TaskConstructor<T> = {
    action: TaskAction<T>,
    description?: string,
    isTicking?: boolean,
    totalTicks?: number
}

class Task extends EventEmitter {
    ticks: number = 0;
    totalTicks: number = 0;
    isTicking: boolean = false;
    description: string = "no description given";
    action: TaskAction<*>;
    result: any;
    error: any;
    status: string = 'created';

    constructor({action, description = "no description given", isTicking = false, totalTicks = 0}: TaskConstructor<*>) {
        super();
        this.action = action;
        this.description = description;
        this.isTicking = isTicking;
        this.totalTicks = totalTicks;
    }

    state(status: string) {
        this.status = status;
        this.emit(status, this);
    }

    async execute(input: any) {
        try {
            this.state('execute');
            this.result = await this.action(input, this);
            this.state('done');
        } catch (e) {
            this.error = e;
            this.emit('error', e, this);
            this.status = 'error';
            throw e;
        }
    }

    toPromise(): Promise<any> {
        if (this.status === 'created') {
            return (async () => await this.execute(null))();
        }

        return new Promise<any>((res, rej) => {
            this.once('done', () => {
                res(this.result);
            });

            this.once('error', (e) => {
                rej(e);
            })
        })
    }

    progress(ticks: number) {
        this.ticks = ticks;
        this.emit('progress', this);
    }


}

type TaskWithQueueConstructor<T> = {
    action: TaskAction<T>,
    tasks: Task[],
    description?: string
}


class TaskWithQueue extends Task {
    tasks: Task[] = [];
    taskIndex: number = 0;

    constructor({action, tasks, description = "no description given"}: TaskWithQueueConstructor<*>) {
        super({
            action,
            description,
            isTicking: true,
            totalTicks: tasks.length
        });
        this.tasks = tasks;
        this.taskIndex = 0;
    }

    allowTaskAddition() {
        return this.status !== 'done' && this.status !== 'error'
    }

    prependTask(task: Task) {
        if (this.allowTaskAddition()) {
            throw new Error("Can't add tasks after list is finished or a task failed");
        }

        this.tasks.splice(this.taskIndex, 0, task);
        this.totalTicks++;
    }

    addTask(task: Task) {
        if (this.allowTaskAddition()) {
            throw new Error("Can't add tasks after list is finished or a task failed");
        }

        this.tasks.push(task);
        this.totalTicks++;
    }
}

type TaskController = {
    addTask(task: Task): void,
    prependTask(task: Task): void
}

type TaskListConstructor = {
    tasks: Task[],
    description?: string,
    controller?: TaskController
}

class TaskList extends TaskWithQueue {
    wait: boolean = false;
    empty: boolean = false;
    controller: TaskController;

    constructor({tasks = [], description = "no description given", controller}: TaskListConstructor) {
        super({
            action: async (input, t) => t.runTasks(input),
            tasks,
            description
        });
        this.controller = controller || this;
    }

    async runTasks(input: any) {
        let state = input || {};
        let last = false;

        while (this.taskIndex < this.tasks.length) {
            this.empty = false;
            let task = this.tasks[this.taskIndex];
            task.on('error', (e, c) => this.emit('child/error', e, c));
            task.on('execute', (c) => this.emit('child/execute', c));
            task.on('progress', (c) => this.emit('child/progress', c));
            task.on('done', (c) => this.emit('child/done', c));
            last = await task.execute({state, last, controller: this.controller});
            this.progress(this.taskIndex++);

            if (this.tasks.length <= this.taskIndex) {
                // Emit empty event then stay idle in case we've been ordered to wait
                this.emit('empty', this);
                this.empty = true;
                await this.stayIdle();
            }
        }
    }

    pause() {
        this.wait = true;
    }

    resume() {
        this.wait = false;
    }

    async stayIdle() {
        const immediate = () => new Promise((res) => {
            setImmediate(() => {
                res();
            })
        });

        do {
            await immediate();
        } while (this.wait)
    }
}

type TaskBucketConstructor = {
    tasks: Task[],
    parallel?: number,
    description?: string
}

class TaskBucket extends TaskWithQueue {
    taskLists: TaskList[] = [];
    parallel: number = 10;
    tasks: Task[];
    clearing: boolean = false;
    taskIndex: number = 0;

    constructor({tasks, parallel = 10, description = "no description given"}: TaskBucketConstructor) {
        super({
            action: (input, t) => t.executeTasks(input),
            tasks,
            description
        });

        this.parallel = parallel;
    }

    checkDone() {
        for (let taskList of this.taskLists) {
            if (!taskList.empty) return;
        }


        for (let taskList of this.taskLists) {
            taskList.resume();
        }
    }

    async runTasks() {
        while (this.taskLists.length < this.parallel) {
            let taskList = new TaskList({
                tasks: [],
                controller: this
            });
            taskList.pause();
            taskList.on('child/error', (e, c) => this.emit('child/error', e, c));
            taskList.on('child/execute', (c) => this.emit('child/execute', c));
            taskList.on('child/progress', (c) => this.emit('child/progress', c));
            taskList.on('child/done', (c) => {
                this.emit('child/done', c);
                this.progress(this.ticks + 1);
            });
            taskList.on('empty', (list: TaskList) => {
                if (this.taskIndex >= this.tasks.length) {
                    this.checkDone();
                    return;
                }

                list.addTask(this.tasks[this.taskIndex++]);
            });
            this.taskLists.push(taskList);
        }

        await Promise.all(this.taskLists.map((task) => task.execute(null)));
    }


    allowTaskAddition(): * {
        return !this.clearing && super.allowTaskAddition();
    }
}

class TaskUtil {
    static create(action: TaskAction<*>, description: string = "no description given"): Task {
        return new Task({action, description});
    }

    static createTicking(action: TaskAction<*>, totalTicks: number, description: string = "no description given"): Task {
        return new Task({action, description, totalTicks, isTicking: true});
    }

    static createBucket(tasks: Task[], parallel = 10, description = "no description given"): TaskBucket {
        return new TaskBucket({tasks, parallel, description});
    }

    static createList(tasks: Task[], description = "no description given"): TaskList {
        return new TaskList({tasks, description});
    }
}

type BuildTaskDefinition = {
    description?: string,
    action: TaskAction<*>,
    ticks?: number,
}

class BuildUtil {
    static list(...tasks: BuildTaskDefinition[]): TaskList {
        return TaskUtil.createList({
            tasks: tasks.map((task) => BuildUtil.one(task))
        });
    }

    static one(task: BuildTaskDefinition): Task {
        if (task.ticks) {
            return TaskUtil.createTicking(task.action, task.ticks, task.description);
        }

        return TaskUtil.create(task.action, task.description)
    }

    static parallelMap<T>(items: T[], action: (input: T, task: Task) => Promise<any>, parallel?: number = 10, descriptionMap?: (input: T) => string) {

    }
}

