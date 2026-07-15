export type Run = <
  Commands extends string | string[],
  Inherit extends boolean = false
>(
  commands: Commands,
  options?: { cwd?: string; inherit?: Inherit; gitSshKeyName?: string }
) => Promise<
  Inherit extends true ? null : Commands extends string ? string : string[]
>;

export type TryCatch = <
  Return,
  MsgOrFn extends string | ((err: string) => void | Promise<void>),
  Warning extends boolean = false
>(
  fn: () => Return | Promise<Return>,
  msgOrFn?: Warning extends true ? string : MsgOrFn,
  isWarn?: Warning
) => Promise<Return> | never;

export type LogType = "info" | "success" | "warning" | "error";
