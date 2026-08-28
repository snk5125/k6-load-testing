FROM grafana/k6:latest
COPY protos /protos
COPY k6-vector-assessment.js /scripts/
ENTRYPOINT ["k6","run","/scripts/k6-vector-assessment.js"]
