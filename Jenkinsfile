pipeline {
  agent { label 'linux' }

  options {
    disableConcurrentBuilds()
    /* manage how many builds we keep */
    buildDiscarder(logRotator(
      numToKeepStr: '20',
      daysToKeepStr: '30',
    ))
  }

  parameters {
    string(
      name: 'GIT_REF',
      defaultValue: 'master',
      description: 'Branch, tag, or commit to build.'
    )
    string(
      name: 'IMAGE_NAME',
      description: 'Docker image name.',
      defaultValue: params.IMAGE_NAME ?: 'acid-info/strapi',
    )
    string(
      name: 'IMAGE_TAG',
      description: 'Docker image tag.',
      defaultValue: getDefaultImageTag(params.IMAGE_TAG)
    )
    string(
      name: 'DOCKER_CRED',
      description: 'Name of Docker Registry credential.',
      defaultValue: params.DOCKER_CRED ?: 'harbor-acid-info-robot',
    )
    string(
      name: 'DOCKER_REGISTRY_URL',
      description: 'URL of the Docker Registry',
      defaultValue: params.DOCKER_REGISTRY_URL ?: 'https://harbor.status.im'
    )
  }

  stages {
    stage('Build') {
      steps { script {
        image = docker.build(
          "${params.IMAGE_NAME}:${params.IMAGE_TAG ?: GIT_REF}",
          "--build-arg='GIT_COMMIT=${GIT_COMMIT.take(8)}' ."
        )
      } }
    }

    stage('Push') {
      steps { script {
        withDockerRegistry([
          credentialsId: params.DOCKER_CRED, url: params.DOCKER_REGISTRY_URL
        ]) {
          image.push()
          /* If Git ref is a tag push it as Docker tag too. */
          if (params.GIT_REF ==~ /v\d+\.\d+\.\d+.*/) {
            image.push(params.GIT_REF)
          }
        }
      } }
    }
  }
  post {
      always { cleanWs()}
    }
}
  def getDefaultImageTag(currentValue) {
    switch (env.JOB_BASE_NAME) {
      case 'docker-latest':  return 'latest'
      case 'docker-release': return 'stable'
      case 'docker-manual':  return ''
      default:               return currentValue
    }
  }
