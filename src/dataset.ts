import { readFileSync } from 'fs';
import { EvalCase } from './types';

export class EvalDataset<TInput = string> {
  private readonly _cases: EvalCase<TInput>[];

  constructor(cases: EvalCase<TInput>[]) {
    this._cases = cases;
  }

  static async fromJsonl<TInput>(path: string): Promise<EvalDataset<TInput>> {
    const content = readFileSync(path, 'utf-8');
    const cases = content
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as EvalCase<TInput>);
    return new EvalDataset<TInput>(cases);
  }

  static fromArray<TRaw, TInput>(
    items: TRaw[],
    mapper: (item: TRaw) => EvalCase<TInput>
  ): EvalDataset<TInput> {
    return new EvalDataset<TInput>(items.map(mapper));
  }

  get cases(): EvalCase<TInput>[] {
    return this._cases;
  }

  get size(): number {
    return this._cases.length;
  }
}
