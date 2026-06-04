FROM eclipse-temurin:17-jre
WORKDIR /corenlp

ENV CORENLP_VERSION=4.5.7

RUN apt-get update \
 && apt-get install -y --no-install-recommends curl unzip \
 && curl -L -o corenlp.zip \
      "https://nlp.stanford.edu/software/stanford-corenlp-${CORENLP_VERSION}.zip" \
 && unzip -q corenlp.zip \
 && mv "stanford-corenlp-${CORENLP_VERSION}"/* . \
 && rm -rf "stanford-corenlp-${CORENLP_VERSION}" corenlp.zip \
 && apt-get remove -y curl unzip \
 && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/*

EXPOSE 9000

CMD ["java", "-mx6g", "-cp", "*", \
     "edu.stanford.nlp.pipeline.StanfordCoreNLPServer", \
     "-port", "9000", "-timeout", "60000", "-threads", "4", "-quiet"]
