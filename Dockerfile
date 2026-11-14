# The hosted editor: one container, no database. Each visitor gets a private workspace under /data.
FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY *.py ./
COPY viewer ./viewer
COPY data/tissue_2k ./data/tissue_2k
COPY data/practice ./data/practice
RUN mkdir -p /data
ENV HOSTED=1 DATA_DIR=/data PORT=8080 PYTHONUNBUFFERED=1
EXPOSE 8080
CMD ["python", "serve.py"]
