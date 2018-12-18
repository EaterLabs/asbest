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
  ticks: number;
  totalTicks: number;
  isTicking: boolean;
  description: string;
  action: TaskAction<*>;
  result: any;
  error: any;
  status: string;

  constructor({action, description = "no description given", isTicking = false, totalTicks = 0}: TaskConstructor<*>) {
    super();
    this.action = action;
    this.description = description;
    this.isTicking = isTicking;
    this.totalTicks = totalTicks;
    this.ticks = 0;
    this.status = 'created';
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

    return this.result;
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
  tasks: Task[];
  taskIndex: number;

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
  controller?: TaskController,
  isQueue?: boolean
}

class TaskList extends TaskWithQueue {
  wait: boolean;
  empty: boolean;
  isQueue: boolean;
  controller: TaskController;

  constructor({tasks = [], description = "no description given", controller, isQueue = false}: TaskListConstructor) {
    super({
      action: async (input, t) => t.runTasks(input),
      tasks,
      description
    });
    this.controller = controller || this;
    this.wait = false;
    this.empty = false;
    this.isQueue = isQueue;
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
      last = await task.execute(this.isQueue ? input : {state, last, controller: this.controller});
      this.progress(this.taskIndex++);

      if (this.tasks.length <= this.taskIndex) {
        // Emit empty event then stay idle in case we've been ordered to wait
        this.emit('empty', this);
        this.empty = true;
        await this.stayIdle();
      }
    }

    return last;
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
  description?: string,
  collect?: ?TaskBucketCollect
}

type TaskBucketCollect = (tasks: Task[], input: any) => any;

class TaskBucket extends TaskWithQueue {
  taskLists: TaskList[];
  parallel: number;
  collect: ?TaskBucketCollect;
  clearing: boolean;

  constructor({tasks, parallel = 10, description = "no description given", collect}: TaskBucketConstructor) {
    super({
      action: (input, t) => {
        return t.runTasks(input)
      },
      tasks,
      description
    });

    this.collect = collect;
    this.taskLists = [];
    this.parallel = parallel;
    this.clearing = false;
  }

  checkDone() {
    for (let taskList of this.taskLists) {
      if (!taskList.empty) return;
    }


    for (let taskList of this.taskLists) {
      taskList.resume();
    }
  }

  async runTasks(input: any) {
    while (this.taskLists.length < this.parallel) {
      let taskList = new TaskList({
        tasks: [],
        controller: this,
        isQueue: true
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

    await Promise.all(this.taskLists.map((task) => task.execute(input)));

    if (this.collect) {
      return this.collect(this.tasks, input);
    }

    return this.tasks.map((x: Task): any => x.result);
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

  static createBucket(tasks: Task[], parallel: number = 10, collect: ?TaskBucketCollect = undefined, description: string = "no description given"): TaskBucket {
    return new TaskBucket({tasks, parallel, description, collect});
  }

  static createList(tasks: Task[], description: string = "no description given"): TaskList {
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
    return TaskUtil.createList(tasks.map((task) => BuildUtil.one(task)));
  }

  static one(task: BuildTaskDefinition): Task {
    if (task instanceof Task) {
      return task;
    }

    if (task.ticks) {
      return TaskUtil.createTicking(task.action, task.ticks, task.description);
    }

    return TaskUtil.create(task.action, task.description)
  }

  static parallel({tasks, parallel = 10, description = 'no description given', collect}: { tasks: BuildTaskDefinition[], parallel: number, description: string, collect: TaskBucketCollect }) {
    return TaskUtil.createBucket(
      tasks.map((task) => BuildUtil.one(task)),
      parallel,
      collect,
      description
    );
  }

  static map<T>({items, action, descriptionMap}: { items: T[], action: (input: T, task: Task) => Promise<any>, descriptionMap?: (input: T) => string }): Task[] {
    return items.map(
      (item: T) => (BuildUtil.one({
        action: async (_, t: Task) => {
          return await action(item, t);
        },
        description: descriptionMap ? descriptionMap(item) : 'no description given'
      }))
    )
  }

  static listMap<T>({items, action, description, descriptionMap}: {
    items: T[],
    action: (input: T, task: Task) => Promise<any>,
    descriptionMap?: (input: T) => string,
    description?: string
  }) {
    return TaskUtil.createList(
      BuildUtil.map({items, action, descriptionMap}),
      description
    )
  }

  static parallelMap<T>({items, action, description, parallel = 10, descriptionMap, collect}: {
    items: T[],
    action: (input: T, task: Task) => Promise<any>,
    parallel?: number,
    descriptionMap?: (input: T) => string,
    description?: string,
    collect?: ?TaskBucketCollect
  }) {
    return TaskUtil.createBucket(
      BuildUtil.map({items, action, descriptionMap}),
      parallel,
      collect,
      description
    )
  }
}

const build = BuildUtil.list;
build.one = BuildUtil.one;
build.parallel = BuildUtil.parallel;
build.map = BuildUtil.map;
build.list = BuildUtil.list;
build.parallelMap = BuildUtil.parallelMap;
build.listMap = BuildUtil.listMap;

module.exports = {
  build,
  TaskUtil,
  BuildUtil,
  Task,
  TaskBucket,
  TaskList
};