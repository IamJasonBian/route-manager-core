import * as cdk from 'aws-cdk-lib';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import * as codepipeline_actions from 'aws-cdk-lib/aws-codepipeline-actions';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { Environment, getEnvironmentConfig, defaultEnvironment } from './config';

export interface NetlifyDeployStackProps extends cdk.StackProps {
  /**
   * The target environment for deployment.
   * @default 'gamma'
   */
  targetEnvironment?: Environment;

  /**
   * GitHub repository owner.
   */
  githubOwner: string;

  /**
   * GitHub repository name.
   */
  githubRepo: string;

  /**
   * GitHub branch to deploy from.
   * @default 'main'
   */
  githubBranch?: string;
}

export class NetlifyDeployStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: NetlifyDeployStackProps) {
    super(scope, id, props);

    const targetEnv = props.targetEnvironment || defaultEnvironment;
    const envConfig = getEnvironmentConfig(targetEnv);
    const branch = props.githubBranch || 'main';

    // Reference existing secrets from Secrets Manager
    const netlifyAuthToken = secretsmanager.Secret.fromSecretNameV2(
      this,
      'NetlifyAuthToken',
      'route-manager/netlify-auth-token'
    );

    const netlifyAlphaSiteId = secretsmanager.Secret.fromSecretNameV2(
      this,
      'NetlifyAlphaSiteId',
      'route-manager/netlify-site-id-alpha'
    );


    // Create CodeBuild project for building and deploying
    const buildProject = new codebuild.PipelineProject(this, 'NetlifyBuildProject', {
      projectName: `route-manager-${targetEnv}-build`,
      description: `Build and deploy Route Manager to ${targetEnv}`,
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
        computeType: codebuild.ComputeType.SMALL,
      },
      environmentVariables: {
        NETLIFY_AUTH_TOKEN: {
          type: codebuild.BuildEnvironmentVariableType.SECRETS_MANAGER,
          value: netlifyAuthToken.secretArn,
        },
        NETLIFY_SITE_ID: {
          type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
          value: envConfig.siteId,
        },
        TARGET_ENV: {
          type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
          value: targetEnv,
        },
      },
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          install: {
            'runtime-versions': {
              nodejs: '20',
            },
            commands: [
              'npm ci',
              'npm install -g netlify-cli',
            ],
          },
          build: {
            commands: [
              'echo "Building for environment: $TARGET_ENV"',
              'npm run build',
            ],
          },
          post_build: {
            commands: [
              'echo "Deploying to Netlify site: $NETLIFY_SITE_ID"',
              'netlify deploy --dir=dist --prod --site $NETLIFY_SITE_ID',
              'echo "Deployment complete!"',
            ],
          },
        },
        artifacts: {
          files: ['dist/**/*'],
        },
      }),
    });

    // Grant permissions to read secrets
    netlifyAuthToken.grantRead(buildProject);
    netlifyAlphaSiteId.grantRead(buildProject);

    // Create CodePipeline
    const pipeline = new codepipeline.Pipeline(this, 'DeployPipeline', {
      pipelineName: `route-manager-${targetEnv}-pipeline`,
      restartExecutionOnUpdate: true,
    });

    // Source stage - GitHub
    const sourceOutput = new codepipeline.Artifact('SourceOutput');
    const sourceAction = new codepipeline_actions.GitHubSourceAction({
      actionName: 'GitHub_Source',
      owner: props.githubOwner,
      repo: props.githubRepo,
      branch: branch,
      oauthToken: cdk.SecretValue.secretsManager('route-manager/github-token'),
      output: sourceOutput,
      trigger: codepipeline_actions.GitHubTrigger.WEBHOOK,
    });

    pipeline.addStage({
      stageName: 'Source',
      actions: [sourceAction],
    });

    // Build and Deploy stage
    const buildOutput = new codepipeline.Artifact('BuildOutput');
    const buildAction = new codepipeline_actions.CodeBuildAction({
      actionName: 'Build_And_Deploy',
      project: buildProject,
      input: sourceOutput,
      outputs: [buildOutput],
    });

    pipeline.addStage({
      stageName: 'Build_Deploy',
      actions: [buildAction],
    });

    // Add manual approval for prod deployments
    if (envConfig.isProtected) {
      pipeline.addStage({
        stageName: 'Approval',
        actions: [
          new codepipeline_actions.ManualApprovalAction({
            actionName: 'Approve_Prod_Deploy',
            notifyEmails: [], // Add notification emails if needed
            additionalInformation: `Approve deployment to ${targetEnv} environment`,
          }),
        ],
      });
    }

    // Outputs
    new cdk.CfnOutput(this, 'PipelineArn', {
      value: pipeline.pipelineArn,
      description: 'ARN of the deployment pipeline',
    });

    new cdk.CfnOutput(this, 'TargetEnvironment', {
      value: targetEnv,
      description: 'Target deployment environment',
    });

    new cdk.CfnOutput(this, 'DeploymentUrl', {
      value: envConfig.url,
      description: 'URL of the deployed application',
    });
  }
}
