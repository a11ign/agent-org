// A `run` for the plugin's operation tests: it records the arguments it was handed and answers `answer`, or throws it when it is an Error (a `gh` that failed). A string is stdout as it is; anything else is JSON.
export function recording(answer: unknown | Error | ((args: string[]) => unknown)) {
  const asked: string[][] = [];
  const run = (args: string[]): string => {
    asked.push(args);
    const given = typeof answer === "function" ? (answer as (args: string[]) => unknown)(args) : answer;
    if (given instanceof Error) throw given;
    return typeof given === "string" ? given : JSON.stringify(given);
  };
  return { run, asked };
}
