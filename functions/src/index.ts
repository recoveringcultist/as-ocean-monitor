import * as functions from "firebase-functions";
import { Request, Response } from "express";
import { createBot } from "./bot";
import { Telegraf } from "telegraf";

let bot: Telegraf;
createBot().then((b) => {
  bot = b;
});

export const botFunction = functions.https.onRequest(
  async (req: Request, res: Response) => {
    try {
      await bot.handleUpdate(req.body);
    } finally {
      res.status(200).end();
    }
  }
);
