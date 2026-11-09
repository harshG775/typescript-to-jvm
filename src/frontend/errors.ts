import type * as ts from 'typescript';

export class FrontendError extends Error {
  readonly fileName: string;
  /** Zero-based. */
  readonly line: number;
  /** Zero-based. */
  readonly col: number;

  constructor(message: string, fileName: string, line: number, col: number) {
    super(`${fileName}:${line + 1}:${col + 1}: ${message}`);
    this.name = 'FrontendError';
    this.fileName = fileName;
    this.line = line;
    this.col = col;
  }
}

export function errorAtNode(node: ts.Node, msg: string): never {
  const sf = node.getSourceFile();
  const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
  throw new FrontendError(msg, sf.fileName, line, character);
}
