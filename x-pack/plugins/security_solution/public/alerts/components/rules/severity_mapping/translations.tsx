/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License;
 * you may not use this file except in compliance with the Elastic License.
 */

import { i18n } from '@kbn/i18n';

export const SEVERITY = i18n.translate(
  'xpack.securitySolution.alerts.severityMapping.severityTitle',
  {
    defaultMessage: 'Default severity',
  }
);

export const SOURCE_FIELD = i18n.translate(
  'xpack.securitySolution.alerts.severityMapping.sourceFieldTitle',
  {
    defaultMessage: 'Source field',
  }
);

export const SOURCE_VALUE = i18n.translate(
  'xpack.securitySolution.alerts.severityMapping.sourceValueTitle',
  {
    defaultMessage: 'Source value',
  }
);

export const SEVERITY_MAPPING = i18n.translate(
  'xpack.securitySolution.alerts.severityMapping.severityMappingTitle',
  {
    defaultMessage: 'Severity override',
  }
);

export const SEVERITY_DESCRIPTION = i18n.translate(
  'xpack.securitySolution.alerts.severityMapping.defaultDescriptionLabel',
  {
    defaultMessage: 'Select a severity level for all alerts generated by this rule.',
  }
);

export const SEVERITY_MAPPING_DESCRIPTION = i18n.translate(
  'xpack.securitySolution.alerts.severityMapping.mappingDescriptionLabel',
  {
    defaultMessage: 'Map a value from the source event to a specific severity.',
  }
);

export const SEVERITY_MAPPING_DETAILS = i18n.translate(
  'xpack.securitySolution.alerts.severityMapping.mappingDetailsLabel',
  {
    defaultMessage:
      'For multiple matches the highest severity match will apply. If no match is found, the default severity will be used.',
  }
);
