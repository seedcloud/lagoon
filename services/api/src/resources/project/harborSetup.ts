import * as R from 'ramda';
import { MariaClient } from 'mariasql';
import harborClient from '../../clients/harborClient';
import logger from '../../logger';
import { Sql as PSql } from './sql';
import { Sql } from '../env-variables/sql';
import { isPatchEmpty, prepare, query, whereAnd } from '../../util/db';

const lagoonHarborRoute = R.compose(
  R.defaultTo('http://172.17.0.1:8084'),
  R.find(R.test(/harbor-nginx/)),
  R.split(','),
  R.propOr('', 'LAGOON_ROUTES'),
)(process.env) as string;

const lagoonWebhookAddress = R.compose(
  R.defaultTo('http://webhook-handler:3000'),
  R.find(R.test(/webhook-handler/)),
  R.split(','),
  R.propOr('', 'LAGOON_ROUTES'),
)(process.env) as string;

async function createHarborProject(sqlClient: MariaClient, harborClient, lagoonProjectName: string) {
  // Returns an empty string on an error and a string on a success

  // Create harbor project
  try {
    var res = await harborClient.post(`projects`, {
      body: {
        count_limit: -1,
        project_name: lagoonProjectName,
        storage_limit: -1,
        metadata: {
          auto_scan: "true",
          reuse_sys_cve_whitelist: "true",
          public: "false"
        }
      }
    });
    logger.debug(`Harbor project ${lagoonProjectName} created!`)
  } catch (err) {
    if (err.statusCode == 409) {
      // 409 means project already exists
      logger.info(`Unable to create the harbor project "${lagoonProjectName}", as it already exists in harbor, continuing with existing project`)
    } else {
      logger.error(`Unable to create the harbor project "${lagoonProjectName}", error: ${err}`)
      return ""
    }
  }

  // Get new harbor project's id
  try {
    const res = await harborClient.get(`projects?name=${lagoonProjectName}`)
    var harborProjectID = res.body[0].project_id
    logger.debug(`Harbor project id for ${lagoonProjectName} is: ${harborProjectID}`)
  } catch (err) {
    if (err.statusCode == 404) {
      logger.error(`Unable to get the harbor project id of "${lagoonProjectName}", as it does not exist in harbor!`)
      return
    } else {
      logger.error(`Unable to get the harbor project id of "${lagoonProjectName}" !!`)
      return ""
    }
  }
  return harborProjectID
}

async function createRobot(sqlClient: MariaClient, harborClient, lagoonProjectName: string, harborProjectID: string) {
  // Returns false on an error and a token object on a success

  // Create robot account for new harbor project
  try {
    const timestamp = Math.floor(Date.now() / 1000)
    var robotName = `${lagoonProjectName}-${timestamp}`

    const res = await harborClient.post(`projects/${harborProjectID}/robots`, {
      body: {
        name: robotName,
        access: [
          {
            resource: `/project/${harborProjectID}/repository`,
            action: "push"
          }
        ]
      }
    })
    var harborTokenInfo = res.body
    logger.debug(`Robot ${robotName} was created for Harbor project ${lagoonProjectName} !`)
  } catch (err) {
    // 409 means project already exists
    // 201 means project created successfully
    if (err.statusCode == 409) {
      logger.warn(`Unable to create a robot account for harbor project "${lagoonProjectName}", as a robot account of the same name already exists!`)
    } else {
      logger.error(`Unable to create a robot account for harbor project "${lagoonProjectName}"!`, err)
      return false
    }
  }
  return harborTokenInfo
}

async function removeHarborEnvVars(sqlClient: MariaClient, lagoonProjectName: string) {
  // Returns false on an error and true on a success

  // Find any currently set env vars
  var old_env_vars = [];
  try {
    const result = await query(
      sqlClient,
      PSql.selectProjectByName(lagoonProjectName),
    );
    const env_vars = await query(
      sqlClient,
      `SELECT *
      FROM env_vars
      WHERE project = '${result[0].id}'
      AND scope = 'internal_container_registry'`
    );

    for (var i=0; i < env_vars.length; i++) {
      old_env_vars.push(env_vars[i])
    }
  } catch (err) {
    logger.info(`Unable to get current env vars for project: ${lagoonProjectName}`, err)
  }

  // Remove any previously set internal_container_registry env vars
  try {
    for (var j=0; j < old_env_vars.length; j++) {
      await query(
        sqlClient,
        Sql.deleteEnvVariable (old_env_vars[j].id)
      );
      logger.debug(`Removed ${old_env_vars[j].name} env var from project ${lagoonProjectName}`)
    }
  } catch (err) {
    logger.error(`Unable to remove ${old_env_vars[j].name} env var from project ${lagoonProjectName}`, err)
    return false
  }

  return true
}

async function addEnvVar(sqlClient: MariaClient, lagoonProjectName: string, name: string, value: string, scope: string, project: string) {
  // Returns false on an error and true on a success
  try {
    await query(
      sqlClient,
      Sql.insertEnvVariable({
        "name": name,
        "value": value,
        "scope": scope,
        "project": parseInt(project, 10),
      }),
    );
    logger.debug(`Environment variable ${name} for ${lagoonProjectName} created!`)
  } catch (err) {
    logger.error(`Error while setting ${name} variable for ${lagoonProjectName}, error: ${err}`)
    return false
  }
  return true
}

async function resetHarborWebhook(sqlClient: MariaClient, harborClient, lagoonProjectName: string, lagoonWebhookAddress: string, harborProjectID: string) {
  // Returns false on an error and true on a success

  // Get current webhooks for Harbor project
  let old_webhooks = []
  try {
    const res = await harborClient.get(`projects/${harborProjectID}/webhook/policies`);

    for (var i = 0; i < res.body.length; i++) {
      old_webhooks.push(res.body[i])
    }
  } catch (err) {
    logger.info(`Unable to retrieve list of current webhooks for Harbor Project: ${lagoonProjectName}`, err)
  }

  // Remove old webhooks from Harbor project
  try {
    for (var j=0; j < old_webhooks.length; j++) {
      var result = await harborClient.delete(`projects/${harborProjectID}/webhook/policies/${old_webhooks[j].id}`, {
        body: {
          project_id: harborProjectID,
          policy_id: old_webhooks[j].id
        }
      });
      logger.debug(`Removed ${old_webhooks[j].name} webhook from Harbor project ${lagoonProjectName}`)
    }
  } catch (err) {
    logger.error(`Unable to remove ${old_webhooks[j].name} webhook from Harbor project ${lagoonProjectName}`, err)
    return false
  }

  // Set webhook for Harbor Project
  try {
    var res = await harborClient.post(`projects/${harborProjectID}/webhook/policies`, {
      body: {
        targets: [
          {
            type: "http",
            skip_cert_verify: true,
            address: lagoonWebhookAddress
          }
        ],
        event_types: [
          "scanningFailed",
          "scanningCompleted"
        ],
        name: "Lagoon Default Webhook",
        enabled: true
      }
    });
    logger.debug(`Created Lagoon default webhook for Harbor project: ${lagoonProjectName}`)
  } catch (err) {
    logger.error(`Error while creating a webhook in the Harbor project for ${lagoonProjectName}, error: ${err}`)
    return false
  }
  return true
}

export const createHarborOperations = (sqlClient /* : MariaSQL */) => ({
  addProject: async (lagoonProjectName, projectID) => {
    // Create harbor project
    const harborProjectID = await createHarborProject(sqlClient, harborClient, lagoonProjectName)
    if (harborProjectID == "") {return}

    // Create robot account for new harbor project
    var harborTokenInfo = await createRobot(sqlClient, harborClient, lagoonProjectName, harborProjectID)
    if (harborTokenInfo == false) {return}

    // Remove previously set internal registry env vars
    if (! await removeHarborEnvVars(sqlClient, lagoonProjectName)) {return}

    // Set required Lagoon env vars to enable Harbor on this project
    if (! await addEnvVar(sqlClient, lagoonProjectName, "INTERNAL_REGISTRY_URL", lagoonHarborRoute, "INTERNAL_CONTAINER_REGISTRY", projectID)) {return}
    if (! await addEnvVar(sqlClient, lagoonProjectName, "INTERNAL_REGISTRY_USERNAME", harborTokenInfo.name, "INTERNAL_CONTAINER_REGISTRY", projectID)) {return}
    if (! await addEnvVar(sqlClient, lagoonProjectName, "INTERNAL_REGISTRY_PASSWORD", harborTokenInfo.token, "INTERNAL_CONTAINER_REGISTRY", projectID)) {return}

    // Reset harbor project webhook to point to this Lagoon's Harbor
    if (! await resetHarborWebhook(sqlClient, harborClient, lagoonProjectName, lagoonWebhookAddress, harborProjectID)) {return}
  }
})
