/* Configuration Playwright — parcours en navigateur réel.

   Un seul navigateur, Chromium. Multiplier les moteurs multiplierait la
   durée de la chaîne pour attraper des écarts de rendu qui n'intéressent
   personne ici : ce que ces tests cherchent, ce sont des scripts bloqués,
   une mise en page absente, des tuiles qui ne suivent pas les données —
   des défauts qui se produisent dans tous les navigateurs à la fois.

   Deux formats d'écran, en revanche : la mosaïque est calculée à partir de
   la largeur disponible, c'est donc là que le risque se trouve.           */

import { defineConfig, devices } from "@playwright/test";

const BASE = process.env.BASE ?? "https://lisia.y-factor.fr";

export default defineConfig({
  testDir: ".",
  testMatch: /.*\.spec\.mjs$/,

  // Aucun test ne doit dépendre d'un autre : la page est publique et en
  // lecture seule, rien n'empêche de les mener de front.
  fullyParallel: true,

  // Un test qui ne passe qu'une fois sur deux est un test cassé. On ne
  // relance pas : mieux vaut voir l'intermittence que la masquer.
  retries: 0,

  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [["list"], ["github"]] : [["list"]],

  use: {
    baseURL: BASE,
    ignoreHTTPSErrors: false,        // le certificat doit être valide
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },

  projects: [
    { name: "bureau", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 900 } } },
    { name: "mobile", use: { ...devices["Pixel 5"] } },
  ],
});
