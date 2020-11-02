/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License;
 * you may not use this file except in compliance with the Elastic License.
 */
import Boom from '@hapi/boom';
import { combineLatest } from 'rxjs';
import { first, map } from 'rxjs/operators';
import { i18n } from '@kbn/i18n';
import { has, get } from 'lodash';
import { TypeOf } from '@kbn/config-schema';
import {
  Logger,
  PluginInitializerContext,
  RequestHandlerContext,
  KibanaRequest,
  KibanaResponseFactory,
  CoreSetup,
  ILegacyCustomClusterClient,
  CoreStart,
  CustomHttpResponseOptions,
  ResponseError,
  IClusterClient,
  SavedObjectsServiceStart,
} from 'kibana/server';
import { DEFAULT_APP_CATEGORIES } from '../../../../src/core/server';
import {
  LOGGING_TAG,
  KIBANA_MONITORING_LOGGING_TAG,
  KIBANA_STATS_TYPE_MONITORING,
  ALERTS,
  SAVED_OBJECT_TELEMETRY,
} from '../common/constants';
import { MonitoringConfig, createConfig, configSchema } from './config';
// @ts-ignore
import { requireUIRoutes } from './routes';
// @ts-ignore
import { initBulkUploader } from './kibana_monitoring';
// @ts-ignore
import { initInfraSource } from './lib/logs/init_infra_source';
import { mbSafeQuery } from './lib/mb_safe_query';
import { instantiateClient } from './es_client/instantiate_client';
import { registerCollectors } from './kibana_monitoring/collectors';
import { registerMonitoringCollection } from './telemetry_collection';
import { LicenseService } from './license_service';
import { AlertsFactory } from './alerts';
import {
  MonitoringCore,
  MonitoringLicenseService,
  LegacyShimDependencies,
  IBulkUploader,
  PluginsSetup,
  PluginsStart,
  LegacyRequest,
} from './types';
import { CoreServices } from './core_services';

// This is used to test the version of kibana
const snapshotRegex = /-snapshot/i;

const wrapError = (error: any): CustomHttpResponseOptions<ResponseError> => {
  const options = { statusCode: error.statusCode ?? 500 };
  const boom = Boom.isBoom(error) ? error : Boom.boomify(error, options);
  return {
    body: boom,
    headers: boom.output.headers,
    statusCode: boom.output.statusCode,
  };
};

export class Plugin {
  private readonly initializerContext: PluginInitializerContext;
  private readonly log: Logger;
  private readonly getLogger: (...scopes: string[]) => Logger;
  private cluster = {} as ILegacyCustomClusterClient;
  private licenseService = {} as MonitoringLicenseService;
  private monitoringCore = {} as MonitoringCore;
  private legacyShimDependencies = {} as LegacyShimDependencies;
  private bulkUploader: IBulkUploader = {} as IBulkUploader;
  private telemetryElasticsearchClient: IClusterClient | undefined;
  private telemetrySavedObjectsService: SavedObjectsServiceStart | undefined;

  constructor(initializerContext: PluginInitializerContext) {
    this.initializerContext = initializerContext;
    this.log = initializerContext.logger.get(LOGGING_TAG);
    this.getLogger = (...scopes: string[]) => initializerContext.logger.get(LOGGING_TAG, ...scopes);
  }

  async setup(core: CoreSetup, plugins: PluginsSetup) {
    const [config, legacyConfig] = await combineLatest([
      this.initializerContext.config
        .create<TypeOf<typeof configSchema>>()
        .pipe(map((rawConfig) => createConfig(rawConfig))),
      this.initializerContext.config.legacy.globalConfig$,
    ])
      .pipe(first())
      .toPromise();

    CoreServices.init(core);

    const router = core.http.createRouter();
    this.legacyShimDependencies = {
      router,
      instanceUuid: this.initializerContext.env.instanceUuid,
      esDataClient: core.elasticsearch.legacy.client,
      kibanaStatsCollector: plugins.usageCollection?.getCollectorByType(
        KIBANA_STATS_TYPE_MONITORING
      ),
    };

    // Monitoring creates and maintains a connection to a potentially
    // separate ES cluster - create this first
    const cluster = (this.cluster = instantiateClient(
      config.ui.elasticsearch,
      this.log,
      core.elasticsearch.legacy.createClient
    ));

    // Start our license service which will ensure
    // the appropriate licenses are present
    this.licenseService = new LicenseService().setup({
      licensing: plugins.licensing,
      monitoringClient: cluster,
      config,
      log: this.log,
    });

    const serverInfo = core.http.getServerInfo();
    let kibanaUrl = `${serverInfo.protocol}://${serverInfo.hostname}:${serverInfo.port}`;
    if (core.http.basePath.serverBasePath) {
      kibanaUrl += `/${core.http.basePath.serverBasePath}`;
    }
    const getUiSettingsService = async () => {
      const coreStart = (await core.getStartServices())[0];
      return coreStart.uiSettings;
    };
    const isCloud = Boolean(plugins.cloud?.isCloudEnabled);
    const alerts = AlertsFactory.getAll();
    for (const alert of alerts) {
      alert.initializeAlertType(
        getUiSettingsService,
        cluster,
        this.getLogger,
        config,
        kibanaUrl,
        isCloud
      );
      plugins.alerts?.registerType(alert.getAlertType());
    }

    // Initialize telemetry
    if (plugins.telemetryCollectionManager) {
      registerMonitoringCollection({
        telemetryCollectionManager: plugins.telemetryCollectionManager,
        esCluster: this.cluster,
        esClientGetter: () => this.telemetryElasticsearchClient,
        soServiceGetter: () => this.telemetrySavedObjectsService,
        customContext: {
          maxBucketSize: config.ui.max_bucket_size,
        },
      });
    }

    // Register collector objects for stats to show up in the APIs
    if (plugins.usageCollection) {
      core.savedObjects.registerType({
        name: SAVED_OBJECT_TELEMETRY,
        hidden: true,
        namespaceType: 'agnostic',
        mappings: {
          properties: {
            reportedClusterUuids: {
              type: 'keyword',
            },
          },
        },
      });

      registerCollectors(plugins.usageCollection, config, cluster.callAsInternalUser);
    }

    // Always create the bulk uploader
    const kibanaMonitoringLog = this.getLogger(KIBANA_MONITORING_LOGGING_TAG);
    const bulkUploader = (this.bulkUploader = initBulkUploader({
      elasticsearch: core.elasticsearch,
      config,
      log: kibanaMonitoringLog,
      statusGetter$: core.status.overall$,
      kibanaStats: {
        uuid: this.initializerContext.env.instanceUuid,
        name: serverInfo.name,
        index: get(legacyConfig, 'kibana.index'),
        host: serverInfo.hostname,
        locale: i18n.getLocale(),
        port: serverInfo.port.toString(),
        transport_address: `${serverInfo.hostname}:${serverInfo.port}`,
        version: this.initializerContext.env.packageInfo.version,
        snapshot: snapshotRegex.test(this.initializerContext.env.packageInfo.version),
      },
    }));

    // If collection is enabled, start it
    const kibanaCollectionEnabled = config.kibana.collection.enabled;
    if (kibanaCollectionEnabled) {
      // Do not use `this.licenseService` as that looks at the monitoring cluster
      // whereas we want to check the production cluster here
      if (plugins.licensing) {
        plugins.licensing.license$.subscribe((license: any) => {
          // use updated xpack license info to start/stop bulk upload
          const mainMonitoring = license.getFeature('monitoring');
          const monitoringBulkEnabled =
            mainMonitoring && mainMonitoring.isAvailable && mainMonitoring.isEnabled;
          if (monitoringBulkEnabled) {
            bulkUploader.start(plugins.usageCollection);
          } else {
            bulkUploader.handleNotEnabled();
          }
        });
      } else {
        kibanaMonitoringLog.warn(
          'Internal collection for Kibana monitoring is disabled due to missing license information.'
        );
      }
    } else {
      kibanaMonitoringLog.info(
        'Internal collection for Kibana monitoring is disabled per configuration.'
      );
    }

    // If the UI is enabled, then we want to register it so it shows up
    // and start any other UI-related setup tasks
    if (config.ui.enabled) {
      // Create our shim which is currently used to power our routing
      this.monitoringCore = this.getLegacyShim(
        config,
        legacyConfig,
        core.getStartServices as () => Promise<[CoreStart, PluginsStart, {}]>,
        this.licenseService,
        this.cluster
      );

      this.registerPluginInUI(plugins);
      requireUIRoutes(this.monitoringCore, {
        router,
        licenseService: this.licenseService,
        encryptedSavedObjects: plugins.encryptedSavedObjects,
      });
      initInfraSource(config, plugins.infra);
    }

    return {
      // OSS stats api needs to call this in order to centralize how
      // we fetch kibana specific stats
      getKibanaStats: () => this.bulkUploader.getKibanaStats(),
    };
  }

  start({ elasticsearch, savedObjects }: CoreStart) {
    // TODO: For the telemetry plugin to work, we need to provide the new ES client.
    // The new client should be inititalized with a similar config to `this.cluster` but, since we're not using
    // the new client in Monitoring Telemetry collection yet, setting the local client allows progress for now.
    // The usage collector `fetch` method has been refactored to accept a `collectorFetchContext` object,
    // exposing both es clients and the saved objects client.
    // We will update the client in a follow up PR.
    this.telemetryElasticsearchClient = elasticsearch.client;
    this.telemetrySavedObjectsService = savedObjects;
  }

  stop() {
    if (this.cluster) {
      this.cluster.close();
    }
    if (this.licenseService) {
      this.licenseService.stop();
    }
  }

  registerPluginInUI(plugins: PluginsSetup) {
    plugins.features.registerKibanaFeature({
      id: 'monitoring',
      name: i18n.translate('xpack.monitoring.featureRegistry.monitoringFeatureName', {
        defaultMessage: 'Stack Monitoring',
      }),
      category: DEFAULT_APP_CATEGORIES.management,
      app: ['monitoring', 'kibana'],
      catalogue: ['monitoring'],
      privileges: null,
      alerting: ALERTS,
      reserved: {
        description: i18n.translate('xpack.monitoring.feature.reserved.description', {
          defaultMessage: 'To grant users access, you should also assign the monitoring_user role.',
        }),
        privileges: [
          {
            id: 'monitoring',
            privilege: {
              app: ['monitoring', 'kibana'],
              catalogue: ['monitoring'],
              savedObject: {
                all: [],
                read: [],
              },
              alerting: {
                all: ALERTS,
              },
              ui: [],
            },
          },
        ],
      },
    });
  }

  getLegacyShim(
    config: MonitoringConfig,
    legacyConfig: any,
    getCoreServices: () => Promise<[CoreStart, PluginsStart, {}]>,
    licenseService: MonitoringLicenseService,
    cluster: ILegacyCustomClusterClient
  ): MonitoringCore {
    const router = this.legacyShimDependencies.router;
    const legacyConfigWrapper = () => ({
      get: (_key: string): string | undefined => {
        const key = _key.includes('monitoring.') ? _key.split('monitoring.')[1] : _key;
        if (has(config, key)) {
          return get(config, key);
        }
        if (has(legacyConfig, key)) {
          return get(legacyConfig, key);
        }

        if (key === 'server.uuid') {
          return this.legacyShimDependencies.instanceUuid;
        }

        throw new Error(`Unknown key '${_key}'`);
      },
    });
    return {
      config: legacyConfigWrapper,
      log: this.log,
      route: (options: any) => {
        const method = options.method;
        const handler = async (
          context: RequestHandlerContext,
          req: KibanaRequest<any, any, any, any>,
          res: KibanaResponseFactory
        ) => {
          const plugins = (await getCoreServices())[1];
          const legacyRequest: LegacyRequest = {
            ...req,
            logger: this.log,
            getLogger: this.getLogger,
            payload: req.body,
            getKibanaStatsCollector: () => this.legacyShimDependencies.kibanaStatsCollector,
            getUiSettingsService: () => context.core.uiSettings.client,
            getActionTypeRegistry: () => context.actions?.listTypes(),
            getAlertsClient: () => {
              try {
                return plugins.alerts.getAlertsClientWithRequest(req);
              } catch (err) {
                // If security is disabled, this call will throw an error unless a certain config is set for dist builds
                return null;
              }
            },
            getActionsClient: () => {
              try {
                return plugins.actions.getActionsClientWithRequest(req);
              } catch (err) {
                // If security is disabled, this call will throw an error unless a certain config is set for dist builds
                return null;
              }
            },
            server: {
              config: legacyConfigWrapper,
              newPlatform: {
                setup: {
                  plugins,
                },
              },
              plugins: {
                monitoring: {
                  info: licenseService,
                },
                elasticsearch: {
                  getCluster: (name: string) => ({
                    callWithRequest: async (_req: any, endpoint: string, params: any) => {
                      const client =
                        name === 'monitoring' ? cluster : this.legacyShimDependencies.esDataClient;
                      return mbSafeQuery(() =>
                        client.asScoped(req).callAsCurrentUser(endpoint, params)
                      );
                    },
                  }),
                },
              },
            },
          };
          try {
            const result = await options.handler(legacyRequest);
            return res.ok({ body: result });
          } catch (err) {
            const statusCode: number =
              err.output?.statusCode || err.statusCode || err.status || 500;
            if (Boom.isBoom(err) || statusCode !== 500) {
              return res.customError({ statusCode, body: err });
            }
            return res.internalError(wrapError(err));
          }
        };

        const validate: any = get(options, 'config.validate', false);
        if (validate && validate.payload) {
          validate.body = validate.payload;
        }
        options.validate = validate;

        if (method === 'POST') {
          router.post(options, handler);
        } else if (method === 'GET') {
          router.get(options, handler);
        } else if (method === 'PUT') {
          router.put(options, handler);
        } else {
          throw new Error('Unsupport API method: ' + method);
        }
      },
    };
  }
}
