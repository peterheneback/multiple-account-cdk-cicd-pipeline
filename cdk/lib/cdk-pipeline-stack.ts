import { Construct } from 'constructs';
import { Stage, StageProps, Stack, StackProps, RemovalPolicy } from 'aws-cdk-lib';
import { CodePipeline, CodePipelineSource, ManualApprovalStep, ShellStep, Wave } from 'aws-cdk-lib/pipelines';
import { GraphqlApiStack } from './api-stack';
import { VpcStack } from './vpc-stack';
import { RDSStack } from './rds-stack';
import { IDatabaseInstance } from 'aws-cdk-lib/aws-rds';
import { NagSuppressions } from 'cdk-nag';
import { CfnBucket, Bucket, BlockPublicAccess, BucketEncryption } from 'aws-cdk-lib/aws-s3';
import { CrossRegionSupport } from 'aws-cdk-lib/aws-codepipeline';


export interface AppStageProps extends StageProps {
  primaryRdsInstance?: IDatabaseInstance,
  secretReplicationRegions?: string[]
}

class AppStage extends Stage {
  public readonly apiStack: GraphqlApiStack;
  public readonly rdsStack: RDSStack;

  constructor(scope: Construct, id: string, props?: AppStageProps) {
    super(scope, id, props);
    
    const vpcStack = new VpcStack(this, 'VPCStack');

    this.rdsStack = new RDSStack(this, 'RDSStack', {
      vpc: vpcStack.vpc,
      securityGroup: vpcStack.ingressSecurityGroup,
      stage: id,
      secretReplicationRegions: props?.secretReplicationRegions || [],
      primaryRdsInstance: props?.primaryRdsInstance
    });

    this.apiStack = new GraphqlApiStack(this, 'APIStack', {
      vpc: vpcStack.vpc,
      inboundDbAccessSecurityGroup:
        this.rdsStack.postgresRDSInstance.connections.securityGroups[0].securityGroupId,
      rdsEndpoint: this.rdsStack.postgresRDSInstance.dbInstanceEndpointAddress,
      rdsDbUser: this.rdsStack.rdsDbUser,
      rdsDbName: this.rdsStack.rdsDbName,
      rdsPort: this.rdsStack.rdsPort,
      rdsPasswordSecretName: this.rdsStack.rdsDatabasePasswordSecretName.value,
    });
  }
}

export class CdkPipelineStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // Suppressing cdk-nag errors
    NagSuppressions.addStackSuppressions(this, [
      {
        id: 'AwsSolutions-IAM5',
        reason: 'Supressing errors originating in external packages.'
      }
    ])

    const githubOrg = process.env.GITHUB_ORG || 'undefined-github-org';
    const githubRepo = process.env.GITHUB_REPO || 'undefined-github-repo';
    const githubBranch = process.env.GITHUB_BRANCH || 'main';
    const devAccountId = process.env.DEV_ACCOUNT_ID || 'undefined';
    const stgAccountId = process.env.STG_ACCOUNT_ID || 'undefined';
    const prdAccountId = process.env.PRD_ACCOUNT_ID || 'undefined';
    const primaryRegion = process.env.PRIMARY_REGION || 'undefined';
    const secondaryRegion = process.env.SECONDARY_REGION || 'undefined';
    const acccessLogsBucketNameStr = 'MultiAccountAccessLogsBucket';

    const pipeline = new CodePipeline(this, 'Pipeline', {
      enableKeyRotation: true, // Recommended by cdk-nag
      crossAccountKeys: true,
      pipelineName: 'AwsSamplesPipeline',
      synth: new ShellStep('deploy', {
        input: CodePipelineSource.gitHub(`${githubOrg}/${githubRepo}`, githubBranch),
        commands: [ 
          'npm ci',
          'npm run build',
          'npx cdk synth'
        ]
      }),
    });
    

    const devQaWave = pipeline.addWave('DEV-and-QA-Deployments');
    const dev = new AppStage(this, 'dev', {
      env: { account: devAccountId, region: primaryRegion }
    });
    
    const qa = new AppStage(this, 'qa', {
      env: { account: devAccountId, region: secondaryRegion }
    });
    
    devQaWave.addStage(dev);
    devQaWave.addStage(qa);

    const primaryRdsRegionWave = pipeline.addWave('Primary-DB-Region-Deployments', {
      pre: [new ManualApprovalStep('ProdManualApproval')]
    });
    const stgPrimary = new AppStage(this, 'stg-primary', {
      env: { account: stgAccountId, region: primaryRegion },
      secretReplicationRegions: [secondaryRegion]
    });
    const prdPrimary = new AppStage(this, 'prd-primary', {
      env: { account: prdAccountId, region: primaryRegion },
      secretReplicationRegions: [secondaryRegion]
    });
    primaryRdsRegionWave.addStage(stgPrimary);
    primaryRdsRegionWave.addStage(prdPrimary);
    
    const secondaryRdsRegionWave = pipeline.addWave('Secondary-DB-Region-Deployments');
    const stgBackup = new AppStage(this, 'stg-backup', {
      env: { account: stgAccountId, region: secondaryRegion },
      primaryRdsInstance: stgPrimary.rdsStack.postgresRDSInstance
    });
    const prdBackup = new AppStage(this, 'prd-backup', {
      env: { account: prdAccountId, region: secondaryRegion },
      primaryRdsInstance: prdPrimary.rdsStack.postgresRDSInstance
    });
    secondaryRdsRegionWave.addStage(stgBackup);
    secondaryRdsRegionWave.addStage(prdBackup);


    pipeline.buildPipeline() // This is required to be able to access the artifact bucket and add supressions. 
    
    // Create S3 bucket for server access logs
    
    const accessLogsBucket = new Bucket(this,acccessLogsBucketNameStr,
      {
        blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
        encryption: BucketEncryption.S3_MANAGED,
        enforceSSL: true,
        // removalPolicy: RemovalPolicy.RETAIN, 
        removalPolicy: RemovalPolicy.DESTROY,   // Remove and uncomment RemovalPolicy.RETAIN to keep bucket after destroying stack 
        autoDeleteObjects: true                // Remove and uncomment RemovalPolicy.RETAIN to keep bucket after destroying stack
      } 
    
    )

    // Add bucket access logs as recommended by cdk-nag
    const artifactBucket = pipeline.pipeline.artifactBucket.node.defaultChild as CfnBucket;
    const logFilePrefixStr = 'logs/';
    artifactBucket.loggingConfiguration = {
          destinationBucketName: accessLogsBucket.bucketName.toString(),
          // destinationBucketName: acccessLogsBucketNameStr,
          logFilePrefix: logFilePrefixStr
    }

    // Add bucket access logs to cross region buckets as recommended by cdk-nag
    const appChildren = scope.node.children;
    for (var i=0; i<appChildren.length; i++){
      if (appChildren[i].constructor.name == 'CrossRegionSupportStack') {
        let crossRegionSupport = (appChildren[i] as unknown) as CrossRegionSupport; // Can't cast from IConstruct to CrossRegionSupport directly
        let crossRegionBucket = crossRegionSupport.replicationBucket.node.defaultChild as CfnBucket;
        crossRegionBucket.loggingConfiguration = {
          destinationBucketName: acccessLogsBucketNameStr,
          logFilePrefix: logFilePrefixStr
        }
      }
    }

  }
}