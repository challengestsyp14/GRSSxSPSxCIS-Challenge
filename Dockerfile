# The report's evaluation in a container: docker build -t ground-link-testbed . && docker run --rm ground-link-testbed
FROM python:3.11-slim
WORKDIR /testbed
ENV PYTHONHASHSEED=0 PIP_DISABLE_PIP_VERSION_CHECK=1
COPY requirements-lock.txt ./
RUN pip install --no-cache-dir -r requirements-lock.txt
COPY pyproject.toml README.md ./
COPY groundlink groundlink
COPY testbed testbed
COPY digital_twin digital_twin
COPY tests tests
COPY results/EXPECTED_SHA256 results/EXPECTED_SHA256_QUICK results/
RUN pip install --no-cache-dir --no-deps -e .
CMD ["python", "-m", "digital_twin.reproduce"]
