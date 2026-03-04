FROM python:3.12-slim
WORKDIR /app
ENV PYTHONUNBUFFERED=1
RUN pip install --no-cache-dir curl_cffi
COPY src/ ./src/
CMD ["python3", "src/scraper-single.py"]
