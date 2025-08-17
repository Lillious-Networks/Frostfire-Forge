// Not sure which type to use but seems not be an massive issue, depends on what you want to be able to do?
// ref https://stackoverflow.com/a/54101543

// export interface SQLController {
//   query<T>(sql: string, values?: any): T[] | any[];
//   queryAsync<T>(sql: string, values?: any): Promise<T[] | any[]>;
// }

export type SQLController = {
  query<T>(sql: string, values?: any): T[] | any[];
  queryAsync<T>(sql: string, values?: any): Promise<T[] | any[]>;
};
