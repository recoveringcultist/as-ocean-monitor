import * as fs from "fs";
import * as functions from "firebase-functions";
import { Request, Response } from "express";
import { createBot } from "./bot";
import { Telegraf } from "telegraf";

var bot: Telegraf;
const { FUNCTION_TARGET } = process.env;

async function setup() {
  // only initialize the bot for the botFunction function
  // functions.logger.info("setup", process.env);
  if (FUNCTION_TARGET == "botFunction") {
    bot = await createBot();
  }
}
setup();

export const botFunction = functions.https.onRequest(
  async (req: Request, res: Response) => {
    if (!bot) {
      bot = await createBot();
    }
    try {
      await bot.handleUpdate(req.body);
    } finally {
      res.status(200).end();
    }
  }
);

/**
 * HTTP Cloud Function that lists files in the function directory
 *
 * @param {Object} req Cloud Function request context.
 * @param {Object} res Cloud Function response context.
 */
// export const listFiles = functions.https.onRequest((req, res) => {
//   fs.readdir(__dirname, (err, files) => {
//     if (err) {
//       console.error(err);
//       res.sendStatus(500);
//     } else {
//       res.send(__dirname + ", " + files.toString());
//     }
//   });
// });
