/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * and the Server Side Public License, v 1; you may not use this file except in
 * compliance with, at your election, the Elastic License or the Server Side
 * Public License, v 1.
 */

import { IRouter } from 'src/core/server';
import { registerImportRoute } from './import';
import { registerExportRoute } from './export';

export const registerRoutes = (
  router: IRouter,
  kibanaVersion: string,
  maxImportPayloadBytes: number
) => {
  registerExportRoute(router, kibanaVersion);
  registerImportRoute(router, maxImportPayloadBytes);
};
