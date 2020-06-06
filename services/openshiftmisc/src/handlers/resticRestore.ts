import { promisify } from 'util';
import R from 'ramda';
import { logger } from '@lagoon/commons/dist/local-logging';
import { sendToLagoonLogs } from '@lagoon/commons/dist/logs';
import {
  getOpenShiftInfoForProject,
} from '@lagoon/commons/dist/api';
import { BaaS } from '@lagoon/commons/dist/openshiftApi';


export async function resticRestore (data) {
  const { backup, restore, project, environment } = data;

  const result = await getOpenShiftInfoForProject(project.name);
  const projectOpenShift = result.project;

  const ocsafety = string =>
    string.toLocaleLowerCase().replace(/[^0-9a-z-]/g, '-');

  try {
    var safeBranchName = ocsafety(environment.name);
    var safeProjectName = ocsafety(project.name);
    var openshiftConsole = projectOpenShift.openshift.consoleUrl.replace(
      /\/$/,
      ''
    );
    var openshiftToken = projectOpenShift.openshift.token || '';
    var openshiftProject = projectOpenShift.openshiftProjectPattern
      ? projectOpenShift.openshiftProjectPattern
          .replace('${branch}', safeBranchName)
          .replace('${project}', safeProjectName)
      : `${safeProjectName}-${safeBranchName}`;
    var restoreName = `restore-${R.slice(0, 7, backup.backupId)}`;
  } catch (error) {
    logger.error(`Error while loading information for project ${project.name}`);
    logger.error(error);
    throw error;
  }

  const restoreConfig = (name, backupId) => {
    let config = {
      apiVersion: 'backup.appuio.ch/v1alpha1',
      kind: 'Restore',
      metadata: {
        name
      },
      spec: {
        snapshot: backupId,
        restoreMethod: {
          s3: {},
        },
        backend: {
          s3: {
            bucket: `baas-${safeProjectName}`
          },
          repoPasswordSecretRef: {
            key: 'repo-pw',
            name: 'baas-repo-pw'
          },
        },
      },
    };

    return config;
  };

  // Kubernetes API Object - needed as some API calls are done to the Kubernetes API part of OpenShift and
  // the OpenShift API does not support them.
  const baas: any = new BaaS({
    url: openshiftConsole,
    insecureSkipTlsVerify: true,
    auth: {
      bearer: openshiftToken
    }
  });

  try {
    const restoreConfigPost = promisify(
      baas.ns(openshiftProject).restores.post
    );
    await restoreConfigPost({
      body: restoreConfig(restoreName, backup.backupId)
    });
  } catch (err) {
    logger.error(err);
    throw new Error();
  }

  logger.verbose(`${openshiftProject}: Creating restore: ${backup.backupId}`);

  sendToLagoonLogs(
    'start',
    project.name,
    '',
    'task:misc-openshift:start',
    data,
    `*[${project.name}]* Restore \`${restore.id}\` *${backup.backupId}* started`
  );
}
