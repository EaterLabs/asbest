const {build} = require('../lib/task');

let list = build(
  {
    description: 'return 1',
    action: () => 1,
  },
  {
    description: 'add 1',
    action: ({last}) => last + 1,
  },
  build.parallel({
    tasks: [
      {
        description: ':o',
        action: () => Date.now(),
      },
      {
        description: 'o:',
        action: () => new Promise((res) => {
          setTimeout(() => {
            res(Date.now())
          }, 400);
        })
      },
      {
        description: 'x:',
        action: () => Date.now(),
      }
    ],
    parallel: 2,
    description: 'Hey!',
    collect: (tasks, input) => {
      input.parallel = tasks.map(a => a.result);
      return input;
    }
  })
);

it('should return 2', async () => {
  let x = await list.execute();
  let y = [...x.parallel].sort()
  expect(y).not.toEqual(x.parallel);
  expect(x.last).toBe(2);
});
