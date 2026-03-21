import query from "../controllers/sqldatabase";

export const checkSession = (session: string, ip: string) => {
  return new Promise((resolve, reject) => {
    query("SELECT * FROM sessions WHERE session = ? AND ip = ?", [session, ip])
      .then((results: any) => {
        if (results.length > 0) {

          query("SELECT passwordreset FROM accounts WHERE email = ?", [
            results[0].email,
          ])
            .then((results2: any) => {
              if (results2.length > 0) {
                if (results2[0].passwordreset === "1") {
                  reject();
                } else {
                  resolve([results[0].email, results[0].code]);
                }
              } else {
                reject();
              }
            })
            .catch((err: any) => {
              reject(err);
            });
        } else {
          reject();
        }
      })
      .catch((err: any) => {
        reject(err);
      });
  });
};

export const checkCode = (email: string, code: string) => {
  return new Promise((resolve, reject) => {
    query("SELECT * FROM sessions WHERE email = ? AND code = ?", [email, code])
      .then((results: any) => {
        if (results.length > 0) {
          resolve(results[0]);
        } else {
          reject();
        }
      })
      .catch((err: any) => {
        reject(err);
      });
  });
};

export const checkAccess = (email: string) => {
  return new Promise((resolve, reject) => {
    query("SELECT access FROM accounts WHERE email = ?", [email])
      .then((results: any) => {
        if (results.length > 0) {
          resolve(results[0].access);
        } else {
          reject();
        }
      })
      .catch((err: any) => {
        reject(err);
      });
  });
};
